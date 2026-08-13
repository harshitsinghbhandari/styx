#!/usr/bin/env bash
# Provisions Styx's cloud layer: SSM secrets, the styx-lambda-exec inline
# policy, five Lambda functions (router, admin-sql, seed, e2e, scene), the
# router's public endpoint, the commitment_events changefeed, and the
# styx-console Fargate deploy (ECR, ECS cluster/service, ALB). Re-run
# safely at any point; every step checks for its own prior work first.
#
# Prereqs: AWS_PROFILE=styx configured, node_modules installed at the repo
# root (npm install), and the cloud DATABASE_URL available at
# ~/.styx-cloud.env (DATABASE_URL=...) the first time this runs (later runs
# read it back out of SSM instead). Docker (with buildx) is required from
# section 6 onward, to build and push the styx-console image.
#
# CockroachDB Cloud cluster reference (created out of band, not by this
# script): styx-main-cluster, Basic tier, AWS us-east-1, host
# styx-main-cluster-31877.j77.aws-us-east-1.cockroachlabs.cloud. Schema is
# applied via the separate styx-migrate Lambda (see cloud-migrate.sh).
#
# NEVER echo DATABASE_URL or the webhook secret. Every AWS CLI call below
# that could print one pipes through --query/--output text into a variable,
# not to the terminal, or reads via SSM WithDecryption inside a Lambda.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AWS_PROFILE="${AWS_PROFILE:-styx}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="247829671541"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/styx-lambda-exec"
KMS_KEY_ARN="arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/1f55ca6c-12b0-4f4b-ab5e-8c2c2d1d52a6"

log() { echo "[provision] $*"; }

# --- 1. SSM parameters ---------------------------------------------------
put_param_if_missing() {
  local name="$1" value="$2"
  if aws ssm get-parameter --name "$name" >/dev/null 2>&1; then
    log "ssm $name already exists, leaving it alone"
  else
    aws ssm put-parameter --name "$name" --type SecureString --value "$value" >/dev/null
    log "ssm $name created"
  fi
}

if aws ssm get-parameter --name /styx/database-url >/dev/null 2>&1; then
  log "ssm /styx/database-url already exists"
else
  if [ ! -f "$HOME/.styx-cloud.env" ]; then
    echo "missing ~/.styx-cloud.env with DATABASE_URL=... ; cannot bootstrap /styx/database-url" >&2
    exit 1
  fi
  DB_URL="$(grep '^DATABASE_URL=' "$HOME/.styx-cloud.env" | cut -d= -f2-)"
  put_param_if_missing /styx/database-url "$DB_URL"
  unset DB_URL
fi

if aws ssm get-parameter --name /styx/webhook-secret >/dev/null 2>&1; then
  log "ssm /styx/webhook-secret already exists"
else
  WEBHOOK_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  put_param_if_missing /styx/webhook-secret "$WEBHOOK_SECRET"
  unset WEBHOOK_SECRET
fi

# --- 2. IAM inline policy on styx-lambda-exec -----------------------------
POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "SsmStyxParams", "Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:GetParameters"], "Resource": "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter/styx/*"},
    {"Sid": "KmsDecryptForSsm", "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "${KMS_KEY_ARN}"},
    {"Sid": "BedrockInvoke", "Effect": "Allow", "Action": "bedrock:InvokeModel", "Resource": "*"}
  ]
}
EOF
)
echo "$POLICY_DOC" > /tmp/styx-lambda-inline-policy.json
aws iam put-role-policy --role-name styx-lambda-exec --policy-name styx-lambda-inline --policy-document file:///tmp/styx-lambda-inline-policy.json >/dev/null
log "iam styx-lambda-inline policy applied (put is idempotent, always overwrites to the current definition)"

# --- 3. Build + deploy the four Lambdas -----------------------------------
# router/src/lambda.ts must build to .cjs, not .js: router/package.json has
# "type": "module", and requiring a CJS-content .js file under that package
# hits a dual-package hazard (see router/src/db.ts's comment on the
# import.meta.url fix this same bundling forced).
#
# Build output always lands in a "dist" subdirectory (per-lambda), matching
# the repo-root .gitignore's generic "dist/" rule, so build artifacts never
# need their own gitignore entries.
# $4 (handler) is "<module-basename>.<exportName>"; the module basename
# also names the bundled file, so the two stay in sync however this is
# invoked.
bundle_and_deploy() {
  local fn_name="$1" entry="$2" workdir="$3" handler="$4" timeout="$5"
  local outdir="$workdir/dist"
  local basename="${handler%%.*}"
  log "bundling $fn_name"
  mkdir -p "$outdir"
  npx esbuild "$entry" --bundle --platform=node --target=node20 \
    --external:@aws-sdk/client-ssm --external:pg-native \
    --outfile="$outdir/$basename.cjs"
  (cd "$outdir" && rm -f lambda.zip && zip -q lambda.zip "$basename.cjs")

  if aws lambda get-function --function-name "$fn_name" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$fn_name" --zip-file "fileb://$outdir/lambda.zip" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$fn_name"
    log "$fn_name code updated"
  else
    aws lambda create-function --function-name "$fn_name" --runtime nodejs20.x \
      --role "$ROLE_ARN" --handler "$handler" --zip-file "fileb://$outdir/lambda.zip" \
      --timeout "$timeout" --memory-size 256 >/dev/null
    aws lambda wait function-active-v2 --function-name "$fn_name"
    log "$fn_name created"
  fi
}

bundle_and_deploy styx-router "$ROOT/router/src/lambda.ts" "$ROOT/router" "lambda.lambdaHandler" 30
bundle_and_deploy styx-admin-sql "$ROOT/scripts/lambda/admin-sql/index.ts" "$ROOT/scripts/lambda/admin-sql" "index.handler" 60
bundle_and_deploy styx-seed "$ROOT/scripts/lambda/seed/index.ts" "$ROOT/scripts/lambda/seed" "index.handler" 30
bundle_and_deploy styx-e2e "$ROOT/scripts/lambda/e2e/index.ts" "$ROOT/scripts/lambda/e2e" "index.handler" 30
bundle_and_deploy styx-scene "$ROOT/scripts/lambda/scene/index.ts" "$ROOT/scripts/lambda/scene" "index.handler" 30

# --- 4. Public endpoint for styx-router ------------------------------------
# A Function URL is created (the hackathon-standard path) but this AWS
# account has an account-level guardrail that 403s anonymous
# lambda:InvokeFunctionUrl calls even with a correct resource policy
# (confirmed: matching AWS-documented policy still 403s at the platform
# layer, not ours). API Gateway HTTP API with a $default AWS_PROXY
# integration uses lambda:InvokeFunction instead and is not subject to that
# guardrail, so it is the endpoint actually given to CREATE CHANGEFEED.
if aws lambda get-function-url-config --function-name styx-router >/dev/null 2>&1; then
  log "styx-router function url already configured"
else
  aws lambda create-function-url-config --function-name styx-router --auth-type NONE >/dev/null
  aws lambda add-permission --function-name styx-router --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null
  log "styx-router function url created (kept for the record; blocked by account guardrail, see above)"
fi

API_ID="$(aws apigatewayv2 get-apis --query "Items[?Name=='styx-router-api'].ApiId | [0]" --output text)"
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID="$(aws apigatewayv2 create-api --name styx-router-api --protocol-type HTTP \
    --target "arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:styx-router" \
    --query 'ApiId' --output text)"
  log "styx-router-api created: $API_ID"
else
  log "styx-router-api already exists: $API_ID"
fi

if aws lambda get-policy --function-name styx-router 2>/dev/null | grep -q "apigw-styx-router-api"; then
  log "apigateway invoke permission already present"
else
  aws lambda add-permission --function-name styx-router --statement-id apigw-styx-router-api \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${AWS_REGION}:${ACCOUNT_ID}:${API_ID}/*/*" >/dev/null
  log "apigateway invoke permission added"
fi

WEBHOOK_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/"
log "public webhook endpoint: $WEBHOOK_URL"

# --- 5. Changefeed on commitment_events ------------------------------------
invoke_admin_sql() {
  local payload_file="$1" out_file="$2"
  aws lambda invoke --function-name styx-admin-sql --cli-read-timeout 60 \
    --payload "fileb://$payload_file" "$out_file" >/dev/null
}

echo '{"statements":["SET CLUSTER SETTING kv.rangefeed.enabled = true"]}' > /tmp/styx-rangefeed.json
invoke_admin_sql /tmp/styx-rangefeed.json /tmp/styx-rangefeed-out.json
RANGEFEED_OK=$(node -e "console.log(require('/tmp/styx-rangefeed-out.json').results[0].ok)")
if [ "$RANGEFEED_OK" = "true" ]; then
  log "kv.rangefeed.enabled set"
else
  RANGEFEED_ERR=$(node -e "console.log(require('/tmp/styx-rangefeed-out.json').results[0].error)")
  log "kv.rangefeed.enabled SET tolerated failure (expected on Basic tier, which ships it on and forbids operator settings): $RANGEFEED_ERR"
fi

EXISTING_JOB=$(node -e "
const { execSync } = require('child_process');
const stmt = \"SELECT job_id FROM [SHOW CHANGEFEED JOBS] WHERE status = 'running' AND description LIKE '%commitment_events%' LIMIT 1\";
require('fs').writeFileSync('/tmp/styx-showjobs.json', JSON.stringify({ statements: [stmt] }));
")
invoke_admin_sql /tmp/styx-showjobs.json /tmp/styx-showjobs-out.json
EXISTING_JOB_ID=$(node -e "
const r = require('/tmp/styx-showjobs-out.json').results[0];
console.log(r.ok && r.rows.length > 0 ? r.rows[0].job_id : '');
")

if [ -n "$EXISTING_JOB_ID" ]; then
  log "changefeed already running: job $EXISTING_JOB_ID, skipping create"
else
  node -e "
    const { execSync } = require('child_process');
    const secret = execSync('aws ssm get-parameter --name /styx/webhook-secret --with-decryption --query Parameter.Value --output text', { env: process.env }).toString().trim();
    const url = process.env.STYX_WEBHOOK_URL;
    const headerJson = JSON.stringify({ 'x-styx-webhook-secret': secret }).replace(/'/g, \"''\");
    const stmt = \"CREATE CHANGEFEED FOR TABLE commitment_events INTO 'webhook-\" + url + \"' WITH updated, resolved='10s', extra_headers='\" + headerJson + \"'\";
    require('fs').writeFileSync('/tmp/styx-createfeed.json', JSON.stringify({ statements: [stmt] }));
  " STYX_WEBHOOK_URL="$WEBHOOK_URL"
  invoke_admin_sql /tmp/styx-createfeed.json /tmp/styx-createfeed-out.json
  NEW_JOB_ID=$(node -e "
    const r = require('/tmp/styx-createfeed-out.json').results[0];
    if (!r.ok) { console.error('changefeed create failed:', r.error); process.exit(1); }
    console.log(r.rows[0].job_id);
  ")
  log "changefeed created: job $NEW_JOB_ID -> $WEBHOOK_URL"
fi

rm -f /tmp/styx-rangefeed*.json /tmp/styx-showjobs*.json /tmp/styx-createfeed*.json

# --- 6. styx-console: ECS execution role -----------------------------------
ECS_EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/styx-ecs-exec"
if aws iam get-role --role-name styx-ecs-exec >/dev/null 2>&1; then
  log "iam role styx-ecs-exec already exists"
else
  cat > /tmp/styx-ecs-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
  aws iam create-role --role-name styx-ecs-exec --assume-role-policy-document file:///tmp/styx-ecs-trust.json >/dev/null
  aws iam wait role-exists --role-name styx-ecs-exec
  log "iam role styx-ecs-exec created"
fi
# AttachRolePolicy is itself idempotent (no error re-attaching the same policy).
aws iam attach-role-policy --role-name styx-ecs-exec \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy >/dev/null
ECS_EXEC_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "SsmStyxParams", "Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:GetParameters"], "Resource": "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter/styx/*"},
    {"Sid": "KmsDecryptForSsm", "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "${KMS_KEY_ARN}"}
  ]
}
EOF
)
echo "$ECS_EXEC_POLICY" > /tmp/styx-ecs-exec-inline.json
aws iam put-role-policy --role-name styx-ecs-exec --policy-name styx-ecs-ssm --policy-document file:///tmp/styx-ecs-exec-inline.json >/dev/null
log "iam styx-ecs-exec ssm/kms inline policy applied"

# --- 7. styx-console: ECR repo, build, push --------------------------------
if aws ecr describe-repositories --repository-names styx-console >/dev/null 2>&1; then
  log "ecr repo styx-console already exists"
else
  aws ecr create-repository --repository-name styx-console --image-scanning-configuration scanOnPush=true >/dev/null
  log "ecr repo styx-console created"
fi
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/styx-console"

log "building styx-console image (linux/amd64) and pushing to $ECR_URI"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_URI" >/dev/null
IMAGE_TAG="$(date -u +%Y%m%dT%H%M%SZ)"
docker buildx build --platform linux/amd64 -t "$ECR_URI:$IMAGE_TAG" -t "$ECR_URI:latest" --load "$ROOT" >/dev/null
docker push "$ECR_URI:$IMAGE_TAG" >/dev/null
docker push "$ECR_URI:latest" >/dev/null
log "styx-console image pushed: $ECR_URI:$IMAGE_TAG"

# --- 8. styx-console: cluster, security groups, ALB, target group ----------
if aws ecs describe-clusters --clusters styx --query 'clusters[?status==`ACTIVE`]' --output text | grep -q styx; then
  log "ecs cluster styx already exists"
else
  aws ecs create-cluster --cluster-name styx >/dev/null
  log "ecs cluster styx created"
fi

VPC_ID="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
SUBNET_IDS="$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text | tr '\t' ',')"

ALB_SG_ID="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=styx-alb-sg" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text)"
if [ "$ALB_SG_ID" = "None" ] || [ -z "$ALB_SG_ID" ]; then
  ALB_SG_ID="$(aws ec2 create-security-group --group-name styx-alb-sg --description "styx ALB: public 80/443" --vpc-id "$VPC_ID" --query 'GroupId' --output text)"
  aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  log "security group styx-alb-sg created: $ALB_SG_ID"
else
  log "security group styx-alb-sg already exists: $ALB_SG_ID"
fi

TASK_SG_ID="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=styx-console-sg" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text)"
if [ "$TASK_SG_ID" = "None" ] || [ -z "$TASK_SG_ID" ]; then
  TASK_SG_ID="$(aws ec2 create-security-group --group-name styx-console-sg --description "styx-console Fargate task: 8080 from the ALB only" --vpc-id "$VPC_ID" --query 'GroupId' --output text)"
  aws ec2 authorize-security-group-ingress --group-id "$TASK_SG_ID" --protocol tcp --port 8080 --source-group "$ALB_SG_ID" >/dev/null
  log "security group styx-console-sg created: $TASK_SG_ID"
else
  log "security group styx-console-sg already exists: $TASK_SG_ID"
fi

ALB_ARN="$(aws elbv2 describe-load-balancers --names styx-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || echo "")"
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  ALB_ARN="$(aws elbv2 create-load-balancer --name styx-alb --type application --scheme internet-facing \
    --subnets $(echo "$SUBNET_IDS" | tr ',' ' ') --security-groups "$ALB_SG_ID" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
  log "alb styx-alb created: $ALB_ARN"
else
  log "alb styx-alb already exists: $ALB_ARN"
fi

TG_ARN="$(aws elbv2 describe-target-groups --names styx-console-tg --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo "")"
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN="$(aws elbv2 create-target-group --name styx-console-tg --protocol HTTP --port 8080 --vpc-id "$VPC_ID" \
    --target-type ip --health-check-path /v1/health --health-check-interval-seconds 15 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
  log "target group styx-console-tg created: $TG_ARN"
else
  log "target group styx-console-tg already exists: $TG_ARN"
fi

LISTENER_ARN="$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query 'Listeners[?Port==`80`].ListenerArn | [0]' --output text 2>/dev/null || echo "")"
if [ -z "$LISTENER_ARN" ] || [ "$LISTENER_ARN" = "None" ]; then
  aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTP --port 80 \
    --default-actions "Type=forward,TargetGroupArn=$TG_ARN" >/dev/null
  log "alb listener :80 created"
else
  log "alb listener :80 already exists"
fi

aws logs create-log-group --log-group-name /ecs/styx-console >/dev/null 2>&1 || true

# --- 9. styx-console: task definition + service ----------------------------
DATABASE_URL_PARAM_ARN="arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter/styx/database-url"
TASK_DEF=$(cat <<EOF
{
  "family": "styx-console",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "$ECS_EXEC_ROLE_ARN",
  "runtimePlatform": {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
  "containerDefinitions": [
    {
      "name": "styx-console",
      "image": "$ECR_URI:$IMAGE_TAG",
      "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
      "environment": [
        {"name": "PUBLIC_READ", "value": "true"},
        {"name": "PORT", "value": "8080"}
      ],
      "secrets": [
        {"name": "DATABASE_URL", "valueFrom": "$DATABASE_URL_PARAM_ARN"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/styx-console",
          "awslogs-region": "$AWS_REGION",
          "awslogs-stream-prefix": "styx-console"
        }
      }
    }
  ]
}
EOF
)
echo "$TASK_DEF" > /tmp/styx-console-taskdef.json
aws ecs register-task-definition --cli-input-json file:///tmp/styx-console-taskdef.json >/dev/null
log "task definition styx-console registered (image tag $IMAGE_TAG)"

SERVICE_STATUS="$(aws ecs describe-services --cluster styx --services styx-console --query 'services[0].status' --output text 2>/dev/null || echo "")"
if [ "$SERVICE_STATUS" = "ACTIVE" ]; then
  aws ecs update-service --cluster styx --service styx-console --task-definition styx-console --desired-count 1 >/dev/null
  log "ecs service styx-console updated to latest task definition"
else
  aws ecs create-service --cluster styx --service-name styx-console --task-definition styx-console \
    --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$TASK_SG_ID],assignPublicIp=ENABLED}" \
    --load-balancers "targetGroupArn=$TG_ARN,containerName=styx-console,containerPort=8080" >/dev/null
  log "ecs service styx-console created"
fi

log "waiting for styx-console service to reach steady state (can take a few minutes on first deploy)"
aws ecs wait services-stable --cluster styx --services styx-console
ALB_DNS="$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)"
log "styx-console is live: http://$ALB_DNS/"

rm -f /tmp/styx-ecs-trust.json /tmp/styx-ecs-exec-inline.json /tmp/styx-console-taskdef.json

log "provisioning complete"
