/**
 * github.mjs — GitHub-related workflow templates.
 *
 * Templates:
 *   - PR Merge Strategy (recommended)
 *   - PR Triage & Labels (recommended)
 *   - PR Conflict Resolver (superseded by Watchdog)
 *   - Stale PR Reaper (recommended)
 *   - Release Drafter
 *   - Bosun PR Watchdog (recommended — replaces pr-cleanup-daemon.mjs; 30 min fallback)
 *   - GitHub ↔ Kanban Sync (recommended — replaces github-reconciler.mjs)
 *   - SDK Conflict Resolver (recommended — replaces sdk-conflict-resolver.mjs)
 *   - GitHub PR Event Handler (recommended — event-driven; reacts to PR opened/updated)
 *   - GitHub Check Failure Handler (recommended — event-driven; labels failing PRs immediately)
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

const BOSUN_CREATED_HTML_MARKER = "<!-- bosun-created -->";
const GITHUB_CI_DIAGNOSTICS_SNIPPET = [
  "const CI_LOG_EXCERPT_MAX_CHARS=12000;",
  "const CI_MAX_JOB_DIAGNOSTICS=10;",
  "const CI_MAX_ANNOTATIONS=60;",
  "function safeGhJsonRunner(runner,args,fallback){try{const out=runner(args);return out?JSON.parse(out):fallback;}catch{return fallback;}}",
  "function parseCheckRunId(value){const match=String(value||'').match(/\\/check-runs\\/(\\d+)/i);return match?Number(match[1]||0)||0:0;}",
  "function normalizeAnnotation(annotation){if(!annotation||typeof annotation!=='object')return null;const path=String(annotation.path||'').trim();const message=truncateText(annotation.message,1200);if(!path&&!message)return null;return {path:path||null,startLine:Number(annotation.start_line||0)||null,endLine:Number(annotation.end_line||0)||null,startColumn:Number(annotation.start_column||0)||null,endColumn:Number(annotation.end_column||0)||null,level:String(annotation.annotation_level||'').trim()||null,title:truncateText(annotation.title,300)||null,message,rawDetails:truncateText(annotation.raw_details,800)||null};}",
  "function collectCheckRunAnnotations(repo,checkRunId,runner){if(!repo||!checkRunId)return [];const annotations=[];for(let page=1;page<=3&&annotations.length<CI_MAX_ANNOTATIONS;page+=1){const batch=safeGhJsonRunner(runner,['api','repos/'+repo+'/check-runs/'+checkRunId+'/annotations?per_page=50&page='+page],[]);if(!Array.isArray(batch)||batch.length===0)break;for(const entry of batch){const normalized=normalizeAnnotation(entry);if(normalized)annotations.push(normalized);if(annotations.length>=CI_MAX_ANNOTATIONS)break;}if(batch.length<50)break;}return annotations.slice(0,CI_MAX_ANNOTATIONS);}",
  "function collectCiDiagnostics(repo,run,runner){const info={failedRun:normalizeRun(run),failedJobs:[],failedAnnotations:[],failedLogExcerpt:'',diagnosticsError:''};const runId=Number(run?.databaseId||0)||0;if(!runId||!repo)return info;let workflowJobs=[];try{const viewRaw=runner(['run','view',String(runId),'--repo',repo,'--json','attempt,conclusion,status,workflowName,displayTitle,url,createdAt,updatedAt,jobs']);const view=(()=>{try{return JSON.parse(viewRaw||'{}')}catch{return {}}})();info.failedRun=normalizeRun({...run,...view});const apiJobs=safeGhJsonRunner(runner,['api','repos/'+repo+'/actions/runs/'+runId+'/jobs?per_page=100'],{});workflowJobs=Array.isArray(apiJobs?.jobs)?apiJobs.jobs:(Array.isArray(view.jobs)?view.jobs:[]);info.failedJobs=workflowJobs.map(normalizeJob).filter((job)=>job&&(FAIL_STATES.has(String(job.conclusion||'').toUpperCase())||job.failedSteps.length>0)).slice(0,CI_MAX_JOB_DIAGNOSTICS);}catch(e){info.diagnosticsError=String(e?.message||e);}try{for(const job of info.failedJobs){const checkRunId=parseCheckRunId(job?.checkRunUrl);const annotations=collectCheckRunAnnotations(repo,checkRunId,runner);if(annotations.length===0)continue;info.failedAnnotations.push({name:String(job?.name||''),checkRunId,annotations});if(info.failedAnnotations.length>=CI_MAX_JOB_DIAGNOSTICS)break;}}catch(e){const message=String(e?.message||e);if(message&&message!==info.diagnosticsError){info.diagnosticsError=info.diagnosticsError?info.diagnosticsError+' | '+message:message;}}try{info.failedLogExcerpt=truncateText(runner(['run','view',String(runId),'--repo',repo,'--log-failed']),CI_LOG_EXCERPT_MAX_CHARS);}catch(e){const message=String(e?.message||e);if(message&&message!==info.diagnosticsError){info.diagnosticsError=info.diagnosticsError?info.diagnosticsError+' | '+message:message;}}return info;}",
].join("");

const GH_CLI_RESILIENCE_SNIPPET = [
  "const GH_MAX_BUFFER=25*1024*1024;",
  "const GH_CACHE_TTL_MS=30000;",
  "const ghReadCache=new Map();",
  "let ghRateLimitUntil=0;",
  "function ghSleep(ms){if(!Number.isFinite(ms)||ms<=0)return;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(ms,5000));}",
  "function ghCacheKey(args){return JSON.stringify(Array.isArray(args)?args:[]);}",
  "function isGhReadOnly(args){const list=Array.isArray(args)?args.map((item)=>String(item||'').trim().toLowerCase()):[];if(list.length===0)return false;const joined=' '+list.join(' ')+' ';return !/( edit | merge | close | reopen | rerun | delete | create | ready | cancel )/.test(joined);}",
  "function readGhMessage(error){return String(error?.stderr||error?.stdout||error?.message||error||'');}",
  "function runGh(args){const cacheable=isGhReadOnly(args);const key=cacheable?ghCacheKey(args):'';const now=Date.now();if(cacheable){const cached=ghReadCache.get(key);if(cached&&cached.expiresAt>now)return cached.output;if(now<ghRateLimitUntil&&cached)return cached.output;}let lastError=null;for(let attempt=0;attempt<2;attempt+=1){try{const output=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:GH_MAX_BUFFER}).trim();if(cacheable)ghReadCache.set(key,{output,expiresAt:Date.now()+GH_CACHE_TTL_MS});return output;}catch(error){const message=readGhMessage(error);lastError=error;const retryAfter=message.match(/retry after\\s+(\\d+)\\s*second/i)||message.match(/try again in\\s+(\\d+)\\s*second/i);if(/secondary rate limit|rate limit exceeded|api rate limit/i.test(message)&&attempt===0){const waitMs=Math.max(1000,Math.min(5000,(Number(retryAfter?.[1]||0)||2)*1000));ghRateLimitUntil=Date.now()+waitMs;ghSleep(waitMs);continue;}if(/ENOBUFS|maxbuffer|stdout maxbuffer length exceeded/i.test(message)&&attempt===0){try{const output=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:GH_MAX_BUFFER*2}).trim();if(cacheable)ghReadCache.set(key,{output,expiresAt:Date.now()+GH_CACHE_TTL_MS});return output;}catch(innerError){lastError=innerError;}}break;}}throw lastError;}",
  "function ghJson(args){const out=runGh(args);return out?JSON.parse(out):[];}",
  "function safeGhJson(args,fallback){try{const out=runGh(args);return out?JSON.parse(out):fallback;}catch{return fallback;}}",
].join("");

export const PR_QUALITY_SIGNAL_SNIPPET = [
  "const QUALITY_FAIL_STATES=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE','FAIL']);",
  "const QUALITY_PENDING_STATES=new Set(['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED']);",
  "const SONAR_CHECK_RE=/(^|[^a-z])(sonarqube|sonarcloud|sonar)([^a-z]|$)/i;",
  "function readCheckName(check){return String(check?.name||check?.context||check?.workflowName||check?.displayTitle||'').trim();}",
  "function safeGhJson(args,fallback,runner){try{const invoke=typeof runner==='function'?runner:runGh;const out=invoke(args);return out?JSON.parse(out):fallback;}catch{return fallback;}}",
  "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
  "function compactUser(user){const login=String(user?.login||user?.name||'').trim();return login?{login,url:String(user?.url||user?.html_url||'').trim()||null}:null;}",
  "function compactCheck(check){const name=readCheckName(check);const state=String(check?.state||check?.conclusion||'').trim().toUpperCase();const bucket=String(check?.bucket||'').trim().toUpperCase();if(!name&&!state&&!bucket)return null;return {name:name||null,state:state||null,bucket:bucket||null,workflow:String(check?.workflowName||'').trim()||null};}",
  "function compactIssueComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,body:truncateText(comment?.body,1200)};}",
  "function compactReview(review){return {id:Number(review?.id||0)||null,author:compactUser(review?.user||review?.author),state:String(review?.state||'').trim()||null,submittedAt:String(review?.submitted_at||review?.submittedAt||'').trim()||null,body:truncateText(review?.body,1200)};}",
  "function compactReviewComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),path:String(comment?.path||'').trim()||null,line:Number(comment?.line||0)||Number(comment?.original_line||0)||null,side:String(comment?.side||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,body:truncateText(comment?.body,1200)};}",
  "function compactFile(file){const filePath=String(file?.filename||file?.path||'').trim();return filePath?{path:filePath,status:String(file?.status||'').trim()||null,additions:Number(file?.additions||0)||0,deletions:Number(file?.deletions||0)||0,changes:Number(file?.changes||0)||0}:null;}",
  "function collectPrDigest(repo,number,fallback,runner){const pr=safeGhJson(['pr','view',String(number),'--repo',repo,'--json','number,title,body,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,author,labels,reviewDecision'],{},runner);const issueComments=safeGhJson(['api','repos/'+repo+'/issues/'+number+'/comments?per_page=100'],[],runner).map(compactIssueComment).slice(0,40);const reviews=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/reviews?per_page=100'],[],runner).map(compactReview).slice(0,40);const reviewComments=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/comments?per_page=100'],[],runner).map(compactReviewComment).slice(0,60);const files=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/files?per_page=100'],[],runner).map(compactFile).filter(Boolean).slice(0,80);const requested=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/requested_reviewers'],{},runner);const requestedReviewers=[...(Array.isArray(requested?.users)?requested.users:[]).map(compactUser),...(Array.isArray(requested?.teams)?requested.teams:[]).map((team)=>{const slug=String(team?.slug||team?.name||'').trim();return slug?{team:slug,url:String(team?.html_url||team?.url||'').trim()||null}:null;})].filter(Boolean);const checks=(Array.isArray(pr?.statusCheckRollup)?pr.statusCheckRollup:[]).map(compactCheck).filter(Boolean);const labels=(Array.isArray(pr?.labels)?pr.labels:[]).map((label)=>String(label?.name||label||'').trim()).filter(Boolean);const failingChecks=checks.filter((check)=>QUALITY_FAIL_STATES.has(String(check?.state||'').toUpperCase())||QUALITY_FAIL_STATES.has(String(check?.bucket||'').toUpperCase()));const pendingChecks=checks.filter((check)=>QUALITY_PENDING_STATES.has(String(check?.state||'').toUpperCase()));const digestSummary=['PR #'+String(pr?.number||number)+' '+String(pr?.title||fallback?.title||''),'repo='+repo+' branch='+(String(pr?.headRefName||fallback?.branch||'').trim()||'unknown'),'checks='+checks.length+' fail='+failingChecks.length+' pending='+pendingChecks.length,'comments='+issueComments.length+' reviews='+reviews.length+' reviewComments='+reviewComments.length+' files='+files.length,labels.length?'labels='+labels.join(', '):''].filter(Boolean).join('\\n');return {core:{number:Number(pr?.number||number)||number,title:String(pr?.title||fallback?.title||''),url:String(pr?.url||fallback?.url||'').trim()||null,body:truncateText(pr?.body,4000),branch:String(pr?.headRefName||fallback?.branch||'').trim()||null,baseBranch:String(pr?.baseRefName||fallback?.base||'').trim()||null,isDraft:pr?.isDraft===true,mergeable:String(pr?.mergeable||'').trim()||null,author:compactUser(pr?.author),reviewDecision:String(pr?.reviewDecision||'').trim()||null},labels,requestedReviewers,checks,ciSummary:{total:checks.length,failing:failingChecks.length,pending:pendingChecks.length,passing:Math.max(0,checks.length-failingChecks.length-pendingChecks.length)},issueComments,reviews,reviewComments,files,digestSummary};}",
  "function isActionableText(value){const text=String(value||'').trim();if(!text)return false;return /(fix|please|should|must|needs?|issue|bug|error|warning|sonar|lint|review|nit|suggest|change|request|fail)/i.test(text);}",
  "function collectActionableReviewSignals(prDigest){const digest=prDigest&&typeof prDigest==='object'?prDigest:{};const reviewComments=Array.isArray(digest.reviewComments)?digest.reviewComments:[];const reviews=Array.isArray(digest.reviews)?digest.reviews:[];const issueComments=Array.isArray(digest.issueComments)?digest.issueComments:[];const checks=Array.isArray(digest.checks)?digest.checks:[];const commentFindings=[];for(const comment of reviewComments){if(!isActionableText(comment?.body))continue;commentFindings.push({kind:'review_comment',path:String(comment?.path||'').trim()||null,line:Number(comment?.line||0)||null,author:String(comment?.author?.login||'').trim()||null,body:String(comment?.body||'').trim(),url:String(comment?.url||'').trim()||null});}for(const review of reviews){const state=String(review?.state||'').trim().toUpperCase();if(state!=='CHANGES_REQUESTED'&&!isActionableText(review?.body))continue;commentFindings.push({kind:'review',state:state||null,author:String(review?.author?.login||'').trim()||null,body:String(review?.body||'').trim(),url:String(review?.url||'').trim()||null});}for(const comment of issueComments){if(!isActionableText(comment?.body))continue;commentFindings.push({kind:'issue_comment',author:String(comment?.author?.login||'').trim()||null,body:String(comment?.body||'').trim(),url:String(comment?.url||'').trim()||null});}const failingChecks=checks.filter((check)=>QUALITY_FAIL_STATES.has(String(check?.state||'').toUpperCase())||QUALITY_FAIL_STATES.has(String(check?.bucket||'').toUpperCase()));const sonarChecks=failingChecks.filter((check)=>SONAR_CHECK_RE.test(String(readCheckName(check)||'')));const qualityChecks=failingChecks.map((check)=>({name:readCheckName(check),state:String(check?.state||check?.bucket||'').trim()||null,workflow:String(check?.workflow||'').trim()||null}));const summary=['commentFindings='+commentFindings.length,'qualityChecks='+qualityChecks.length,sonarChecks.length?'sonarChecks='+sonarChecks.length:''].filter(Boolean).join(' ');return {commentFindings,qualityChecks,sonarChecks,summary};}",
].join(" ");

// ═══════════════════════════════════════════════════════════════════════════
//  PR Merge Strategy
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_MERGE_STRATEGY_TEMPLATE = {
  id: "template-pr-merge-strategy",
  name: "PR Merge Strategy",
  description:
    "Automated PR merge decision workflow with resilient retry paths. " +
    "Analyzes CI + agent output, executes merge/prompt/close/re-attempt " +
    "actions, and escalates gracefully when any branch action fails.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.pr_event",
  variables: {
    ciTimeoutMs: 300000,
    cooldownSec: 60,
    maxRetries: 3,
    baseBranch: "main",
    requireBosunCreatedPr: true,
  },
  nodes: [
    node("trigger", "trigger.pr_event", "PR Ready for Merge Decision", {
      event: "review_requested",
      events: ["review_requested", "approved", "opened"],
    }, { x: 400, y: 50 }),

    node("load-pr-context", "action.run_command", "Load PR Context", {
      command: "gh pr view {{prNumber}} --json body,author,title,labels",
    }, { x: 400, y: 140 }),

    node("automation-eligible", "condition.expression", "Bosun-Created PR?", {
      expression:
        `/* ${BOSUN_CREATED_HTML_MARKER} auto-created by bosun */ (() => { if ($data?.requireBosunCreatedPr !== true && String($data?.requireBosunCreatedPr || '').toLowerCase() !== 'true') return true; const raw = $ctx.getNodeOutput('load-pr-context')?.output || '{}'; let pr = {}; try { pr = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return false; } const labels = Array.isArray(pr?.labels) ? pr.labels.map((entry) => typeof entry === 'string' ? entry : entry?.name).filter(Boolean) : []; const body = String(pr?.body || ''); return labels.includes('bosun-pr-bosun-created') || body.includes('${BOSUN_CREATED_HTML_MARKER}') || /auto-created by bosun/i.test(body); })()`,
    }, { x: 400, y: 230, outputs: ["yes", "no"] }),

    node("check-ci", "validation.build", "Check CI Status", {
      command: "gh pr checks {{prNumber}} --json name,state",
    }, { x: 150, y: 320 }),

    node("get-diff", "action.run_command", "Get Diff Stats", {
      command: "git diff --stat {{baseBranch}}...HEAD",
    }, { x: 650, y: 320 }),

    node("ci-passed", "condition.expression", "CI Passed?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('check-ci'); if (!out || out.passed !== true) return false; let checks = []; try { checks = JSON.parse(out.output || '[]'); } catch { return false; } if (!Array.isArray(checks) || checks.length === 0) return false; const ok = new Set(['SUCCESS', 'PASSED', 'PASS', 'COMPLETED', 'NEUTRAL', 'SKIPPED']); return checks.every((c) => ok.has(String(c?.state || '').toUpperCase())); })()",
    }, { x: 150, y: 470, outputs: ["yes", "no"] }),

    node("wait-for-ci", "action.delay", "Wait for CI", {
      ms: "{{ciTimeoutMs}}",
      seconds: "{{cooldownSec}}",
      reason: "CI is still running",
    }, { x: 150, y: 620 }),

    node("skip-untrusted-pr", "notify.log", "Skip Non-Bosun PR", {
      message: "PR Merge Strategy: skipping PR #{{prNumber}} because it is attached but not Bosun-created",
      level: "info",
    }, { x: 730, y: 230 }),

    node("analyze", "action.run_agent", "Analyze Merge Strategy", {
      prompt: `# PR Merge Strategy Analysis

Review PR #{{prNumber}} on branch {{branch}}.

## Decision Options:
1. **merge_after_ci_pass** — Code looks correct, CI is green, merge it.
2. **prompt** — Agent needs to do more work (provide specific instructions).
3. **close_pr** — PR should be closed (bad approach, duplicate, etc.).
4. **re_attempt** — Start task over with fresh agent.
5. **manual_review** — Escalate to human reviewer.
6. **wait** — CI still running, wait before deciding.
7. **noop** — No action needed.

Respond with JSON: { "action": "<choice>", "reason": "<why>", "message": "<optional details>" }`,
      timeoutMs: 900000,
    }, { x: 400, y: 350 }),

    node("parse-decision", "action.set_variable", "Parse Decision JSON", {
      key: "decision",
      value:
        "(() => { const raw = $ctx.getNodeOutput('analyze')?.output || '{}'; if (raw && typeof raw === 'object') return raw; try { return JSON.parse(String(raw)); } catch { return { action: 'manual_review', reason: 'unparseable merge strategy response', message: String(raw || '') }; } })()",
      isExpression: true,
    }, { x: 400, y: 430 }),

    node("decision-router", "condition.switch", "Route Decision", {
      value:
        "(() => { const action = String($data?.decision?.action || '').trim().toLowerCase(); return action || 'manual_review'; })()",
      cases: {
        merge_after_ci_pass: "merge",
        prompt: "prompt-agent",
        close_pr: "close",
        re_attempt: "retry",
        manual_review: "escalate",
        wait: "wait-for-ci",
        noop: "default",
      },
    }, { x: 400, y: 520, outputs: ["merge", "prompt-agent", "close", "retry", "escalate", "wait-for-ci", "default"] }),

    node("do-merge", "action.run_command", "Auto-Merge PR", {
      command: "gh pr merge {{prNumber}} --auto --merge",
      failOnError: true,
      maxRetries: "{{maxRetries}}",
      retryDelayMs: 30000,
      continueOnError: true,
    }, { x: 100, y: 680 }),

    node("do-prompt", "action.run_agent", "Prompt Agent", {
      prompt: "Continue working on the PR. Instructions: {{decision.message}}",
      timeoutMs: 3600000,
      failOnError: true,
      maxRetries: 2,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 300, y: 680 }),

    node("do-close", "action.run_command", "Close PR", {
      command: "gh pr close {{prNumber}} --comment \"{{decision.reason}}\"",
      failOnError: true,
      maxRetries: 2,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 500, y: 680 }),

    node("do-retry", "action.run_agent", "Re-attempt Task", {
      prompt: "Start the task over from scratch. Previous attempt failed: {{decision.reason}}",
      timeoutMs: 3600000,
      failOnError: true,
      maxRetries: 2,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 700, y: 680 }),

    node("do-escalate", "notify.telegram", "Escalate to Human", {
      message: ":eye: PR #{{prNumber}} needs manual review: {{decision.reason}}",
    }, { x: 900, y: 680 }),

    node("action-succeeded", "condition.expression", "Action Succeeded?", {
      expression:
        "(() => { const action = String($data?.decision?.action || '').trim().toLowerCase(); if (action === 'merge_after_ci_pass') return $ctx.getNodeOutput('do-merge')?.success === true; if (action === 'prompt') return $ctx.getNodeOutput('do-prompt')?.success === true; if (action === 'close_pr') return $ctx.getNodeOutput('do-close')?.success === true; if (action === 're_attempt') return $ctx.getNodeOutput('do-retry')?.success === true; if (action === 'manual_review') return $ctx.getNodeOutput('do-escalate')?.sent !== false; return true; })()",
    }, { x: 480, y: 770, outputs: ["yes", "no"] }),

    node("notify-action-failed", "notify.telegram", "Escalate Action Failure", {
      message:
        ":alert: PR #{{prNumber}} workflow action failed after retries ({{decision.action}}). " +
        "Reason: {{decision.reason}}. Manual follow-up required.",
    }, { x: 760, y: 850 }),

    node("notify-complete", "notify.log", "Log Result", {
      message: "PR #{{prNumber}} merge strategy: {{decision.action}} — {{decision.reason}}",
      level: "info",
    }, { x: 400, y: 850 }),

    node("end", "flow.end", "End Merge Strategy", {
      status: "completed",
      message: "PR merge strategy flow completed for PR #{{prNumber}}",
      output: {
        prNumber: "{{prNumber}}",
        action: "{{decision.action}}",
      },
    }, { x: 400, y: 950 }),
  ],
  edges: [
    edge("trigger", "load-pr-context"),
    edge("load-pr-context", "automation-eligible"),
    edge("automation-eligible", "check-ci", { condition: "$output?.result === true", port: "yes" }),
    edge("automation-eligible", "get-diff", { condition: "$output?.result === true", port: "yes" }),
    edge("automation-eligible", "skip-untrusted-pr", { condition: "$output?.result !== true", port: "no" }),
    edge("check-ci", "ci-passed"),
    edge("ci-passed", "wait-for-ci", { condition: "$output?.result !== true", port: "no" }),
    edge("ci-passed", "analyze", { condition: "$output?.result === true", port: "yes" }),
    edge("get-diff", "analyze"),
    edge("wait-for-ci", "analyze"),
    edge("analyze", "parse-decision"),
    edge("parse-decision", "decision-router"),
    edge("decision-router", "do-merge", { port: "merge" }),
    edge("decision-router", "do-prompt", { port: "prompt-agent" }),
    edge("decision-router", "do-close", { port: "close" }),
    edge("decision-router", "do-retry", { port: "retry" }),
    edge("decision-router", "do-escalate", { port: "escalate" }),
    edge("decision-router", "wait-for-ci", { port: "wait-for-ci" }),
    edge("decision-router", "notify-complete", { port: "default" }),
    edge("do-merge", "action-succeeded"),
    edge("do-prompt", "action-succeeded"),
    edge("do-close", "action-succeeded"),
    edge("do-retry", "action-succeeded"),
    edge("do-escalate", "action-succeeded"),
    edge("action-succeeded", "notify-complete", { condition: "$output?.result === true", port: "yes" }),
    edge("action-succeeded", "notify-action-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("notify-action-failed", "notify-complete"),
    edge("notify-complete", "end"),
    edge("skip-untrusted-pr", "end"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "merge", "strategy", "automation"],
    replaces: {
      module: "merge-strategy.mjs",
      functions: ["analyzeMergeStrategy", "executeDecision", "analyzeAndExecute"],
      calledFrom: ["monitor.mjs:runMergeStrategyAnalysis"],
      description: "Replaces hardcoded merge-strategy analysis and decision execution. " +
        "All 7 decision outcomes (merge, prompt, close, re_attempt, manual_review, wait, noop) " +
        "are encoded as visual workflow branches instead of imperative code.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PR Review Quality Striker
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_REVIEW_QUALITY_STRIKER_TEMPLATE = {
  id: "template-pr-review-quality-striker",
  name: "PR Review Quality Striker",
  description:
    "Reactive PR review sweeper that consolidates actionable review signals " +
    "from reviews, comments, and failing quality checks, then dispatches an " +
    "agent to propose or apply fixes.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.pr_event",
  variables: {
    intervalMs: 1800000,
  },
  nodes: [
    node("trigger", "trigger.pr_event", "PR Review Requested", {
      event: "review_requested",
      events: ["review_requested", "changes_requested", "approved", "opened"],
    }, { x: 220, y: 60 }),

    node("trigger-review-comment", "trigger.event", "Review Comment Event", {
      eventType: "github:pull_request_review_comment",
    }, { x: 520, y: 60 }),

    node("trigger-fallback", "trigger.schedule", "Fallback Sweep", {
      intervalMs: "{{intervalMs}}",
    }, { x: 820, y: 60 }),

    node("fetch-review-signals", "action.run_command", "Fetch Review Signals", {
      command: "node",
      args: ["-e", [
        "const DIRECT_PR_NUMBER=Number(process.env.DIRECT_PR_NUMBER||0);",
        "const DIRECT_REPO=String(process.env.DIRECT_REPO||'').trim();",
        "const DIRECT_PR_URL=String(process.env.DIRECT_PR_URL||'').trim();",
        "const DIRECT_EVENT=String(process.env.DIRECT_EVENT||'').trim();",
        PR_QUALITY_SIGNAL_SNIPPET,
        "function appendActionable(target,items,sourceKind){for(const item of Array.isArray(items)?items:[]){target.push({...item,sourceKind});}}",
        "const modeExpression=\"mode:DIRECT_REPO&&DIRECT_PR_NUMBER>0?'event':'schedule'\";",
        "const mode=DIRECT_REPO&&DIRECT_PR_NUMBER>0?'event':'schedule';",
        "const repo=DIRECT_REPO;",
        "const prNumber=DIRECT_PR_NUMBER;",
        "const prDigest=repo&&prNumber>0?collectPrDigest(repo,prNumber,{url:DIRECT_PR_URL},runGh):{core:{number:prNumber||null,url:DIRECT_PR_URL||null},body:'',files:[],issueComments:[],reviews:[],reviewComments:[],checks:[],digestSummary:''};",
        "const signals=collectActionableReviewSignals(prDigest);",
        "const actionable=[];",
        "appendActionable(actionable,signals.commentFindings,'comment');",
        "appendActionable(actionable,signals.qualityChecks,'quality');",
        "const sourceKind=DIRECT_EVENT?'review_event':'schedule';",
        "process.stdout.write(JSON.stringify({mode,sourceKind,repo,prNumber,prUrl:DIRECT_PR_URL,prDigest,signals,commentFindings:signals.commentFindings,qualityChecks:signals.qualityChecks,actionable}));",
      ].join(" ")],
      env: {
        DIRECT_PR_NUMBER: "{{$data?.prNumber || 0}}",
        DIRECT_REPO: "{{$data?.repo || $data?.repoSlug || $data?.repository || ''}}",
        DIRECT_PR_URL: "{{$data?.prUrl || ''}}",
        DIRECT_EVENT: "{{$data?.event || $data?.eventType || ''}}",
      },
      parseJson: true,
    }, { x: 520, y: 230 }),

    node("run-review-striker", "action.run_agent", "Run Review Striker", {
      prompt: "Use commentFindings and qualityChecks to identify the smallest actionable repair set. Use prDigest with the PR body, files, issue comments, reviews, review comments, and checks to ground the response. Prioritize concrete review feedback over speculative cleanup.",
      sdk: "auto",
      timeoutMs: 1800000,
      failOnError: false,
    }, { x: 520, y: 380 }),

    node("end", "flow.end", "End Review Striker", {
      status: "completed",
      message: "PR review quality striker finished for PR {{prNumber}}.",
    }, { x: 520, y: 520 }),
  ],
  edges: [
    edge("trigger", "fetch-review-signals"),
    edge("trigger-review-comment", "fetch-review-signals"),
    edge("trigger-fallback", "fetch-review-signals"),
    edge("fetch-review-signals", "run-review-striker"),
    edge("run-review-striker", "end"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-31T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "review", "quality", "automation"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  SonarQube PR Striker
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const SONARQUBE_PR_STRIKER_TEMPLATE = {
  id: "template-sonarqube-pr-striker",
  name: "SonarQube PR Striker",
  description:
    "Scheduled PR quality sweep that reacts to failing GitHub-native Sonar " +
    "checks and prepares a repair packet grounded in the shared PR digest.",
  category: "github",
  enabled: true,
  recommended: false,
  trigger: "trigger.schedule",
  variables: {
    intervalMs: 1800000,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Scheduled Sonar Sweep", {
      intervalMs: "{{intervalMs}}",
    }, { x: 420, y: 60 }),

    node("fetch-sonar-signals", "action.run_command", "Fetch Sonar Signals", {
      command: "node",
      args: ["-e", [
        "const DIRECT_PR_NUMBER=Number(process.env.DIRECT_PR_NUMBER||0);",
        "const DIRECT_REPO=String(process.env.DIRECT_REPO||'').trim();",
        PR_QUALITY_SIGNAL_SNIPPET,
        "function hasSonarFailure(signals){return Array.isArray(signals?.sonarChecks)&&signals.sonarChecks.length>0;}",
        "const repo=DIRECT_REPO;",
        "const prNumber=DIRECT_PR_NUMBER;",
        "const prDigest=repo&&prNumber>0?collectPrDigest(repo,prNumber,{},runGh):{core:{number:prNumber||null},body:'',files:[],issueComments:[],reviews:[],reviewComments:[],checks:[],digestSummary:''};",
        "const signals=collectActionableReviewSignals(prDigest);",
        "const hasFailure=hasSonarFailure(signals);",
        "if(signals.sonarChecks.length===0){process.stdout.write(JSON.stringify({repo,prNumber,hasSonarFailure:hasFailure,sonarChecks:signals.sonarChecks,prDigest,signals}));process.exit(0);}",
        "process.stdout.write(JSON.stringify({repo,prNumber,hasSonarFailure:hasFailure,sonarChecks:signals.sonarChecks,prDigest,signals}));",
      ].join(" ")],
      env: {
        DIRECT_PR_NUMBER: "{{$data?.prNumber || 0}}",
        DIRECT_REPO: "{{$data?.repo || $data?.repoSlug || $data?.repository || ''}}",
      },
      parseJson: true,
    }, { x: 420, y: 210 }),

    node("run-sonar-striker", "action.run_agent", "Run Sonar Striker", {
      prompt: "Use GitHub-native Sonar checks as the source of truth. Analyze sonarChecks plus prDigest to decide whether the PR needs a Sonar-focused repair pass and summarize the actionable issues.",
      sdk: "auto",
      timeoutMs: 1800000,
      failOnError: false,
    }, { x: 420, y: 360 }),

    node("end", "flow.end", "End Sonar Striker", {
      status: "completed",
      message: "Sonar striker finished for PR {{prNumber}}.",
    }, { x: 420, y: 500 }),
  ],
  edges: [
    edge("trigger", "fetch-sonar-signals"),
    edge("fetch-sonar-signals", "run-sonar-striker"),
    edge("run-sonar-striker", "end"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-31T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "sonar", "quality", "automation"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PR Triage & Labels
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_TRIAGE_TEMPLATE = {
  id: "template-pr-triage",
  name: "PR Triage & Labels",
  description:
    "Automatically triage incoming PRs: classify by size, detect breaking " +
    "changes, add labels, and assign reviewers based on CODEOWNERS.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.pr_event",
  variables: {
    smallThreshold: 50,
    largeThreshold: 500,
  },
  nodes: [
    node("trigger", "trigger.pr_event", "PR Opened", {
      event: "opened",
    }, { x: 400, y: 50 }),

    node("get-stats", "action.run_command", "Get PR Stats", {
      command: "gh pr view {{prNumber}} --json additions,deletions,files,labels,title,body",
    }, { x: 400, y: 180 }),

    node("classify-size", "condition.switch", "Classify Size", {
      value:
        "(() => { const raw = $ctx.getNodeOutput('get-stats')?.output || '{}'; let stats = {}; try { stats = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { stats = {}; } const delta = Number(stats?.additions || 0) + Number(stats?.deletions || 0); const small = Number($data?.smallThreshold || 50); const large = Number($data?.largeThreshold || 500); if (delta < small) return 'small'; if (delta > large) return 'large'; return 'medium'; })()",
      cases: { small: "small", medium: "medium", large: "large" },
    }, { x: 400, y: 330, outputs: ["small", "medium", "large", "default"] }),

    node("label-small", "action.run_command", "Label: Size/S", {
      command: "gh pr edit {{prNumber}} --add-label \"size/S\"",
    }, { x: 150, y: 480 }),

    node("label-medium", "action.run_command", "Label: Size/M", {
      command: "gh pr edit {{prNumber}} --add-label \"size/M\"",
    }, { x: 400, y: 480 }),

    node("label-large", "action.run_command", "Label: Size/L", {
      command: "gh pr edit {{prNumber}} --add-label \"size/L\"",
    }, { x: 650, y: 480 }),

    node("detect-breaking", "condition.expression", "Detect Breaking Changes", {
      expression:
        "/* <!-- bosun-created --> */ (() => {" +
        "  const raw=$ctx.getNodeOutput('get-stats')?.output||'{}';" +
        "  let stats={};" +
        "  try{stats=typeof raw==='string'?JSON.parse(raw):raw;}catch{return false;}" +
        "  const title=String(stats?.title||'').toLowerCase();" +
        "  const body=String(stats?.body||'').toLowerCase();" +
        "  const files=Array.isArray(stats?.files)?stats.files.map((f)=>String(f?.path||f?.filename||f||'').toLowerCase()):[];" +
        "  const text=title+'\\n'+body;" +
        "  const explicit=/\\bbreaking\\b|\\bbreaking change\\b|\\bmajor\\b|\\bbackward incompatible\\b/.test(text);" +
        "  const apiTouch=files.some((f)=>f.includes('api/')||f.includes('/proto/')||f.includes('openapi')||f.includes('schema'));" +
        "  const contractWords=/\\bremove\\b|\\brename\\b|\\bdeprecate\\b|\\bdrop\\b/.test(text);" +
        "  return explicit || (apiTouch && contractWords);" +
        "})()",
    }, { x: 400, y: 630 }),

    node("is-breaking", "condition.expression", "Breaking?", {
      expression:
        "(() => { return $ctx.getNodeOutput('detect-breaking')?.result === true; })()",
    }, { x: 400, y: 780, outputs: ["yes", "no"] }),

    node("label-breaking", "action.run_command", "Label: Breaking", {
      command: "gh pr edit {{prNumber}} --add-label \"breaking-change\"",
    }, { x: 200, y: 920 }),

    node("done", "notify.log", "Triage Complete", {
      message: "PR #{{prNumber}} triage workflow completed",
      level: "info",
    }, { x: 400, y: 1050 }),
  ],
  edges: [
    edge("trigger", "get-stats"),
    edge("get-stats", "classify-size"),
    edge("classify-size", "label-small", { port: "small" }),
    edge("classify-size", "label-medium", { port: "medium" }),
    edge("classify-size", "label-large", { port: "large" }),
    edge("label-small", "detect-breaking"),
    edge("label-medium", "detect-breaking"),
    edge("label-large", "detect-breaking"),
    edge("detect-breaking", "is-breaking"),
    edge("is-breaking", "label-breaking", { condition: "$output?.result === true", port: "yes" }),
    edge("is-breaking", "done", { condition: "$output?.result !== true", port: "no" }),
    edge("label-breaking", "done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "triage", "labels", "automation"],
    replaces: {
      module: "github-reconciler.mjs",
      functions: ["PR labeling and classification logic"],
      calledFrom: ["monitor.mjs:checkEpicBranches"],
      description: "Replaces scattered PR classification logic with a structured " +
        "triage workflow. Size classification, breaking change detection, " +
        "and label assignment become explicit workflow nodes.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PR Conflict Resolver
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_CONFLICT_RESOLVER_TEMPLATE = {
  id: "template-pr-conflict-resolver",
  name: "PR Conflict Resolver",
  description:
    ":alert: SUPERSEDED for bosun-managed repos — use the Bosun PR Watchdog " +
    "(template-bosun-pr-watchdog) instead. The Watchdog consolidates conflict " +
    "resolution, CI-failure repair, diff-safety review, and merge into one " +
    "cycle with a single gh API call and a mandatory review gate before any merge. " +
    "This template is kept for repos that do not use the assistive bosun-attached label " +
    "convention. It only touches Bosun-created PRs and never " +
    "auto-merges directly — it resolves conflicts and then defers to the " +
    "Watchdog's review gate for the actual merge decision.",
  category: "github",
  enabled: false,
  recommended: false,
  trigger: "trigger.schedule",
  variables: {
    checkIntervalMs: 1800000,
    maxConcurrentFixes: 3,
    maxRetries: 3,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Check Every 30min", {
      intervalMs: "{{checkIntervalMs}}",
      cron: "*/30 * * * *",
    }, { x: 400, y: 50 }),

    // Fetch all open PRs and narrow to Bosun-created provenance.
    // Includes labels so we can skip PRs already tagged bosun-needs-fix (watchdog owns those).
    node("list-prs", "action.run_command", "List Bosun-Created Conflicting PRs", {
      command:
        "gh pr list --state open " +
        "--json number,title,body,headRefName,baseRefName,mergeable,labels --limit {{maxConcurrentFixes}}",
    }, { x: 400, y: 180 }),

    node("target-pr", "action.set_variable", "Pick Conflict PR", {
      key: "targetPrNumber",
      value:
        "/* <!-- bosun-created --> */ (() => {" +
        "  const raw = $ctx.getNodeOutput('list-prs')?.output || '[]';" +
        "  let prs = [];" +
        "  try { prs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }" +
        "  if (!Array.isArray(prs)) return '';" +
        "  const CONFLICT = new Set(['CONFLICTING', 'BEHIND', 'DIRTY']);" +
        "  const BOSUN_CREATED_LABEL = 'bosun-pr-bosun-created';" +
        "  const readLabelNames = (pr) => Array.isArray(pr?.labels) ? pr.labels.map((entry) => typeof entry === 'string' ? entry : entry?.name).filter(Boolean) : [];" +
        "  const hasBosunCreatedText = (value) => { const text = String(value || ''); const taskIdMatch = text.match(/(?:Bosun-Task|VE-Task|Task-ID|task[_-]?id)[:\\s]+([a-zA-Z0-9_-]{4,64})/i); const hasLegacyTaskSignature = Boolean(taskIdMatch && text.toLowerCase().includes(`automated pr for task ${String(taskIdMatch[1] || '').trim().toLowerCase()}`)); return text.includes('<!-- bosun-created -->') || /Bosun-Origin:\\s*created/i.test(text) || /auto-created by bosun/i.test(text) || hasLegacyTaskSignature; };" +
        "  const isBosunCreated = (pr) => readLabelNames(pr).includes(BOSUN_CREATED_LABEL) || hasBosunCreatedText(pr?.body);" +
        "  /* Skip PRs already owned by the watchdog fix agent */" +
        "  const pr = prs.find((p) =>" +
        "    isBosunCreated(p) &&" +
        "    CONFLICT.has(String(p?.mergeable || '').toUpperCase()) &&" +
        "    !(p.labels || []).some((l) => l.name === 'bosun-needs-fix')" +
        "  );" +
        "  return pr?.number ? String(pr.number) : '';" +
        "})()",
      isExpression: true,
    }, { x: 400, y: 260 }),

    node("target-branch", "action.set_variable", "Capture Conflict Branch", {
      key: "targetPrBranch",
      value:
        "/* <!-- bosun-created --> */ (() => {" +
        "  const raw = $ctx.getNodeOutput('list-prs')?.output || '[]';" +
        "  let prs = [];" +
        "  try { prs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }" +
        "  if (!Array.isArray(prs)) return '';" +
        "  const pr = prs.find((p) => String(p?.number || '') === String($data?.targetPrNumber || ''));" +
        "  return pr?.headRefName || '';" +
        "})()",
      isExpression: true,
    }, { x: 400, y: 340 }),

    node("target-base", "action.set_variable", "Capture Base Branch", {
      key: "targetPrBase",
      value:
        "/* <!-- bosun-created --> */ (() => {" +
        "  const raw = $ctx.getNodeOutput('list-prs')?.output || '[]';" +
        "  let prs = [];" +
        "  try { prs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return 'main'; }" +
        "  if (!Array.isArray(prs)) return 'main';" +
        "  const pr = prs.find((p) => String(p?.number || '') === String($data?.targetPrNumber || ''));" +
        "  return pr?.baseRefName || 'main';" +
        "})()",
      isExpression: true,
    }, { x: 400, y: 420 }),

    node("has-conflicts", "condition.expression", "Any Conflicts?", {
      expression: "Boolean($data?.targetPrNumber)",
    }, { x: 400, y: 510 }),

    // Label the PR so the watchdog knows it is being worked on
    node("label-fixing", "action.run_command", "Label bosun-needs-fix", {
      command: "gh pr edit {{targetPrNumber}} --add-label bosun-needs-fix",
      continueOnError: true,
    }, { x: 200, y: 650 }),

    node("resolve-conflicts", "action.run_agent", "Resolve Conflicts", {
      prompt:
        "You are a merge conflict resolution agent for PR #{{targetPrNumber}} " +
        "on branch {{targetPrBranch}} (base: {{targetPrBase}}).\n\n" +
        "Steps:\n" +
        "1. git fetch origin\n" +
        "2. git checkout {{targetPrBranch}}\n" +
        "3. git rebase origin/{{targetPrBase}}   (fall back to merge if rebase is too complex)\n" +
        "4. Resolve all merge conflicts, preserving the intent of both sides.\n" +
        "5. Run the repo's build and test suite to confirm nothing is broken.\n" +
        "6. git push --force-with-lease origin {{targetPrBranch}}\n" +
        "7. Remove the bosun-needs-fix label: gh pr edit {{targetPrNumber}} --remove-label bosun-needs-fix\n\n" +
        "Rules:\n" +
        "- Only make minimal conflict-resolution changes. No unrelated refactors.\n" +
        "- Do NOT merge, close, or approve the PR — the Bosun PR Watchdog handles merging.\n" +
        "- Do NOT touch PRs that are not Bosun-created.",
      sdk: "auto",
      timeoutMs: 1800000,
      failOnError: true,
      maxRetries: "{{maxRetries}}",
      retryDelayMs: 30000,
      continueOnError: true,
    }, { x: 200, y: 800 }),

    node("notify-fixed", "notify.telegram", "Notify Resolved", {
      message: ":settings: PR #{{targetPrNumber}} conflict resolved — awaiting CI and Watchdog review before merge",
      silent: true,
    }, { x: 200, y: 960 }),

    node("notify-failed", "notify.log", "Log Resolution Failed", {
      message: "PR #{{targetPrNumber}} conflict could not be resolved cleanly — manual review required",
      level: "warn",
    }, { x: 450, y: 800 }),

    node("skip", "notify.log", "No Conflicts", {
      message: "PR Conflict Resolver: no unhandled Bosun-created conflicts found",
      level: "info",
    }, { x: 620, y: 510 }),
  ],
  edges: [
    edge("trigger",           "list-prs"),
    edge("list-prs",          "target-pr"),
    edge("target-pr",         "target-branch"),
    edge("target-branch",     "target-base"),
    edge("target-base",       "has-conflicts"),
    edge("has-conflicts",     "label-fixing",       { condition: "$output?.result === true" }),
    edge("has-conflicts",     "skip",               { condition: "$output?.result !== true" }),
    edge("label-fixing",      "resolve-conflicts"),
    edge("resolve-conflicts", "notify-fixed",       { condition: "$ctx.getNodeOutput('resolve-conflicts')?.success === true" }),
    edge("resolve-conflicts", "notify-failed",      { condition: "$ctx.getNodeOutput('resolve-conflicts')?.success !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 2,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "2.0.0",
    tags: ["github", "pr", "conflict", "rebase", "automation", "bosun-attached"],
    replaces: {
      module: "pr-cleanup-daemon.mjs",
      functions: ["PRCleanupDaemon.run", "processCleanup", "resolveConflicts"],
      calledFrom: ["monitor.mjs:startProcess"],
      description:
        "v2: Restricted to Bosun-created PRs only — never touches external-contributor PRs. " +
        "Removed direct auto-merge: this template now only resolves the conflict and pushes; " +
        "the Bosun PR Watchdog (template-bosun-pr-watchdog) owns the merge decision with its " +
        "diff-safety review gate. Skips PRs already tagged bosun-needs-fix (watchdog owns those). " +
        "Labels PR with bosun-needs-fix during resolution so watchdog knows it is in-flight.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Stale PR Reaper
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const STALE_PR_REAPER_TEMPLATE = {
  id: "template-stale-pr-reaper",
  name: "Stale PR Reaper",
  description:
    "Close stale PRs that have been inactive for too long. Posts a " +
    "warning comment before closing and cleans up associated branches.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    staleAfterDays: 14,
    warningBeforeDays: 3,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Daily Check", {
      intervalMs: 86400000,
      cron: "0 8 * * *",
    }, { x: 400, y: 50 }),

    node("find-stale", "action.run_command", "Find Stale PRs", {
      command: "gh pr list --json number,title,updatedAt,headRefName --limit 50",
    }, { x: 400, y: 200 }),

    node("has-stale", "condition.expression", "Any Stale PRs?", {
      expression: "($ctx.getNodeOutput('find-stale')?.output || '[]').length > 2",
    }, { x: 400, y: 350 }),

    node("warn-stale", "action.run_command", "Post Warning Comment", {
      command: "node -e \"const {execFileSync}=require('child_process');const stale=Number('{{staleAfterDays}}')||14;const warn=Number('{{warningBeforeDays}}')||3;const now=Date.now();const prs=JSON.parse(execFileSync('gh',['pr','list','--state','open','--json','number,updatedAt,labels','--limit','100'],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim()||'[]');let n=0;for(const pr of prs){const age=(now-new Date(pr.updatedAt))/864e5;if(age>=(stale-warn)&&age<stale){const lbl=(pr.labels||[]).some(l=>(typeof l==='string'?l:l?.name)==='stale-warning');if(!lbl){try{execFileSync('gh',['pr','comment',String(pr.number),'--body','\\u26a0\\ufe0f This PR has been inactive for '+Math.floor(age)+' day(s) and will be closed in '+Math.ceil(stale-age)+' day(s). Please update or close it if no longer needed.'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});execFileSync('gh',['pr','edit',String(pr.number),'--add-label','stale-warning'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});n++;}catch(e){}}}}console.log('Warned '+n+' PR(s).');\"",
      continueOnError: true,
    }, { x: 200, y: 500 }),

    node("close-stale", "action.run_command", "Close Expired PRs", {
      command: "node -e \"const {execFileSync}=require('child_process');const stale=Number('{{staleAfterDays}}')||14;const now=Date.now();const prs=JSON.parse(execFileSync('gh',['pr','list','--state','open','--json','number,title,updatedAt,headRefName','--limit','100'],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim()||'[]');let n=0;for(const pr of prs){const age=(now-new Date(pr.updatedAt))/864e5;if(age>=stale){try{execFileSync('gh',['pr','close',String(pr.number),'--comment','Automatically closed: inactive for '+Math.floor(age)+' days (threshold: '+stale+' days).','--delete-branch'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});n++;}catch(e){process.stderr.write('close #'+pr.number+': '+(e?.message||e)+'\\n');}}}console.log('Closed '+n+' stale PR(s).');\"",
      continueOnError: true,
    }, { x: 200, y: 650 }),

    node("cleanup-branches", "action.run_command", "Delete Stale Branches", {
      command: "git fetch --prune origin",
    }, { x: 200, y: 800 }),

    node("prune-worktrees", "action.run_command", "Prune Git Worktrees", {
      command: "git worktree prune --expire 7.days.ago 2>/dev/null && echo 'Worktree prune complete.' || echo 'Worktree prune skipped (not a git repo).'",
      continueOnError: true,
    }, { x: 200, y: 950 }),

    node("summary", "notify.telegram", "Summary", {
      message: ":trash: Stale PR cleanup complete",
      silent: true,
    }, { x: 200, y: 1100 }),

    node("skip", "notify.log", "No Stale PRs", {
      message: "No stale PRs found",
      level: "info",
    }, { x: 600, y: 500 }),
  ],
  edges: [
    edge("trigger", "find-stale"),
    edge("find-stale", "has-stale"),
    edge("has-stale", "warn-stale", { condition: "$output?.result === true" }),
    edge("has-stale", "skip", { condition: "$output?.result !== true" }),
    edge("warn-stale", "close-stale"),
    edge("close-stale", "cleanup-branches"),
    edge("cleanup-branches", "prune-worktrees"),
    edge("prune-worktrees", "summary"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "stale", "cleanup"],
    replaces: {
      module: "workspace-reaper.mjs",
      functions: ["runReaperSweep", "cleanOrphanedWorktrees"],
      calledFrom: ["monitor.mjs:runMaintenanceSweep"],
      description:
        "Replaces workspace-reaper.mjs stale PR / orphaned worktree cleanup and " +
        "the pr-cleanup-daemon.mjs temporary worktree remnants. Warning, closing, " +
        "branch deletion, and worktree pruning are explicit, auditable steps.",
      also: ["pr-cleanup-daemon.mjs (temp worktree cleanup)"],
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Release Drafter
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const RELEASE_DRAFTER_TEMPLATE = {
  id: "template-release-drafter",
  name: "Release Drafter",
  description:
    "Automatically generates release notes from merged PRs since the last " +
    "tag. Groups changes by conventional commit type (features, fixes, " +
    "refactors, etc.) and drafts a GitHub release.",
  category: "github",
  enabled: true,
  trigger: "trigger.manual",
  variables: {
    baseBranch: "main",
    releasePrefix: "v",
  },
  nodes: [
    node("trigger", "trigger.manual", "Draft Release Notes", {
      description: "Generate release notes from merged PRs",
    }, { x: 400, y: 50 }),

    node("get-last-tag", "action.run_command", "Get Last Tag", {
      command: "git describe --tags --abbrev=0 2>/dev/null || echo '{{releasePrefix}}0.0.0'",
    }, { x: 400, y: 180 }),

    node("list-prs", "action.run_command", "List Merged PRs", {
      command: "gh pr list --state merged --base {{baseBranch}} --json number,title,labels,author,mergedAt --limit 100",
      continueOnError: true,
    }, { x: 400, y: 310 }),

    node("get-commits", "action.run_command", "Get Commit Log", {
      command: "git log $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~50)..HEAD --oneline --no-merges",
    }, { x: 400, y: 440 }),

    node("draft-notes", "action.run_agent", "Draft Release Notes", {
      prompt: `# Generate Release Notes

## Merged PRs (JSON)
{{prList}}

## Commit Log
{{commitLog}}

## Last Tag
{{lastTag}}

Generate professional release notes in the following format:

# What's Changed

## :rocket: Features
- [list feat: commits with PR references]

## :bug: Bug Fixes
- [list fix: commits with PR references]

## :settings: Improvements
- [list refactor/perf/style commits]

## :u1f4da: Documentation
- [list docs: commits]

## :hammer: Internal
- [list chore/ci/build commits]

Omit empty sections. Include contributor attribution. Be concise.`,
      sdk: "auto",
      timeoutMs: 600000,
    }, { x: 400, y: 590 }),

    node("save-draft", "action.write_file", "Save Draft", {
      path: "RELEASE_DRAFT.md",
      content: "{{releaseNotes}}",
    }, { x: 400, y: 740 }),

    node("notify-ready", "notify.log", "Draft Ready", {
      message: "Release notes draft saved to RELEASE_DRAFT.md — review and publish when ready",
      level: "info",
    }, { x: 400, y: 870 }),
  ],
  edges: [
    edge("trigger", "get-last-tag"),
    edge("get-last-tag", "list-prs"),
    edge("list-prs", "get-commits"),
    edge("get-commits", "draft-notes"),
    edge("draft-notes", "save-draft"),
    edge("save-draft", "notify-ready"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "release", "notes", "changelog", "draft"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Bosun PR Progressor
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const BOSUN_PR_PROGRESSOR_TEMPLATE = {
  id: "template-bosun-pr-progressor",
  name: "Bosun PR Progressor",
  description:
    "Direct per-PR progression workflow for bosun-managed tasks. Runs immediately " +
    "after PR handoff, evaluates a single PR, retries simple CI failures, " +
    "dispatches focused repair when needed, and performs the first merge-review pass " +
    "without waiting for the periodic watchdog.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.workflow_call",
  variables: {
    mergeMethod: "merge",
    labelNeedsFix: "bosun-needs-fix",
    labelNeedsReview: "bosun-needs-human-review",
    suspiciousDeletionRatio: 3,
    minDestructiveDeletions: 500,
  },
  nodes: [
    node("trigger", "trigger.workflow_call", "PR Handoff", {
      inputs: {
        taskId: { type: "string", required: false },
        taskTitle: { type: "string", required: false },
        branch: { type: "string", required: false },
        baseBranch: { type: "string", required: false, default: "main" },
        prNumber: { type: "number", required: false },
        prUrl: { type: "string", required: false },
        repo: { type: "string", required: false },
        reviewIssues: { type: "array", required: false },
        reviewIssueCount: { type: "number", required: false },
        reviewFixDispatchMode: { type: "string", required: false },
        reviewFixRequestedAt: { type: "string", required: false },
      },
    }, { x: 400, y: 50 }),

    node("normalize-context", "action.set_variable", "Normalize PR Context", {
      key: "prProgressContext",
      value:
        "/* <!-- bosun-created --> */ (() => {" +
        "  const prOut = $ctx.getNodeOutput('create-pr') || $ctx.getNodeOutput('create-pr-retry') || {};" +
        "  const prUrl = String($data?.prUrl || prOut?.prUrl || prOut?.url || '').trim();" +
        "  const repoMatch = prUrl.match(/github\\.com\\/([^/]+\\/[^/?#]+)/i);" +
        "  const repo = String($data?.repo || (repoMatch ? repoMatch[1] : '')).trim();" +
        "  const rawPrNumber = $data?.prNumber ?? prOut?.prNumber ?? null;" +
        "  const parsedPrNumber = Number.parseInt(String(rawPrNumber || ''), 10);" +
        "  return {" +
        "    taskId: String($data?.taskId || '').trim() || null," +
        "    taskTitle: String($data?.taskTitle || '').trim() || null," +
        "    repo: repo || null," +
        "    branch: String($data?.branch || prOut?.branch || '').trim() || null," +
        "    baseBranch: String($data?.baseBranch || prOut?.base || 'main').trim() || 'main'," +
        "    prNumber: Number.isFinite(parsedPrNumber) && parsedPrNumber > 0 ? parsedPrNumber : null," +
        "    prUrl: prUrl || null," +
        "    reviewIssues: Array.isArray($data?.reviewIssues) ? $data.reviewIssues : []," +
        "    reviewIssueCount: Number($data?.reviewIssueCount || 0) || 0," +
        "    reviewFixDispatchMode: String($data?.reviewFixDispatchMode || '').trim() || null," +
        "    reviewFixRequestedAt: String($data?.reviewFixRequestedAt || '').trim() || null," +
        "  };" +
        "})()",
      isExpression: true,
    }, { x: 400, y: 180 }),

    node("has-pr-target", "condition.expression", "Has PR Target?", {
      expression:
        "Boolean($data?.prProgressContext?.prNumber && ($data?.prProgressContext?.repo || $data?.prProgressContext?.prUrl))",
    }, { x: 400, y: 300 }),

    node("inspect-pr", "action.run_command", "Inspect Single PR", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const ctx=(()=>{try{return JSON.parse(String(process.env.BOSUN_PR_CONTEXT||'{}'))}catch{return {}}})();",
        "const repo=String(ctx.repo||'').trim();",
        "const branch=String(ctx.branch||'').trim();",
        "const baseBranch=String(ctx.baseBranch||'main').trim()||'main';",
        "const rawNumber=String(ctx.prNumber||'').trim();",
        "const prNumber=Number.parseInt(rawNumber,10);",
        "if(!repo||!Number.isFinite(prNumber)||prNumber<=0){",
        "  console.log(JSON.stringify({success:false,classification:'missing',reason:'missing_repo_or_pr',repo,prNumber:Number.isFinite(prNumber)?prNumber:null,branch,baseBranch}));",
        "  process.exit(0);",
        "}",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function safeGhJson(args,fallback){try{const out=gh(args);return out?JSON.parse(out):fallback;}catch{return fallback;}}",
        "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
        "function compactUser(user){const login=String(user?.login||user?.name||'').trim();return login?{login,url:String(user?.url||user?.html_url||'').trim()||null}:null;}",
        "function compactCheck(check){const name=String(check?.name||check?.context||check?.workflowName||'').trim();const state=String(check?.state||check?.conclusion||'').toUpperCase();const bucket=String(check?.bucket||'').toUpperCase();if(!name&&!state&&!bucket)return null;return {name:name||null,state:state||null,bucket:bucket||null,workflow:String(check?.workflowName||'').trim()||null};}",
        "function compactIssueComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,updatedAt:String(comment?.updated_at||comment?.updatedAt||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactReview(review){return {id:Number(review?.id||0)||null,author:compactUser(review?.user||review?.author),state:String(review?.state||'').trim()||null,submittedAt:String(review?.submitted_at||review?.submittedAt||'').trim()||null,commitId:String(review?.commit_id||review?.commitId||'').trim()||null,body:truncateText(review?.body,1200)};}",
        "function compactReviewComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),path:String(comment?.path||'').trim()||null,line:Number(comment?.line||0)||Number(comment?.original_line||0)||null,startLine:Number(comment?.start_line||0)||null,side:String(comment?.side||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactFile(file){const path=String(file?.filename||file?.path||'').trim();return path?{path,status:String(file?.status||'').trim()||null,additions:Number(file?.additions||0)||0,deletions:Number(file?.deletions||0)||0,changes:Number(file?.changes||0)||0}:null;}",
        "function collectPrDigest(fallback){",
        "  const pr=safeGhJson(['pr','view',String(prNumber),'--repo',repo,'--json','number,title,body,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,author,labels,reviewDecision,state,mergedAt'],{});",
        "  const issueComments=safeGhJson(['api','repos/'+repo+'/issues/'+prNumber+'/comments?per_page=100'],[]).map(compactIssueComment).slice(0,40);",
        "  const reviews=safeGhJson(['api','repos/'+repo+'/pulls/'+prNumber+'/reviews?per_page=100'],[]).map(compactReview).slice(0,40);",
        "  const reviewComments=safeGhJson(['api','repos/'+repo+'/pulls/'+prNumber+'/comments?per_page=100'],[]).map(compactReviewComment).slice(0,60);",
        "  const files=safeGhJson(['api','repos/'+repo+'/pulls/'+prNumber+'/files?per_page=100'],[]).map(compactFile).filter(Boolean).slice(0,80);",
        "  const requested=safeGhJson(['api','repos/'+repo+'/pulls/'+prNumber+'/requested_reviewers'],{});",
        "  const requestedReviewers=[...(Array.isArray(requested?.users)?requested.users:[]).map(compactUser),...(Array.isArray(requested?.teams)?requested.teams:[]).map((team)=>{const slug=String(team?.slug||team?.name||'').trim();return slug?{team:slug,url:String(team?.html_url||team?.url||'').trim()||null}:null;})].filter(Boolean);",
        "  const checks=(Array.isArray(pr.statusCheckRollup)?pr.statusCheckRollup:[]).map(compactCheck).filter(Boolean);",
        "  const labels=(Array.isArray(pr.labels)?pr.labels:[]).map((label)=>String(label?.name||label||'').trim()).filter(Boolean);",
        "  const passingChecks=checks.filter((check)=>check.state==='SUCCESS' || check.bucket==='PASS');",
        "  const failingChecks=checks.filter((check)=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(check.state)||check.bucket==='FAIL');",
        "  const pendingChecks=checks.filter((check)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(check.state));",
        "  const prState=String(pr?.state||'').trim().toUpperCase();",
        "  const mergedAt=String(pr?.mergedAt||'').trim()||null;",
        "  const digestSummary=[",
        "    'PR #'+String(pr?.number||prNumber)+' '+String(pr?.title||fallback?.taskTitle||''),",
        "    'repo='+repo+' branch='+(String(pr?.headRefName||branch||'').trim()||'unknown')+' base='+(String(pr?.baseRefName||baseBranch||'main').trim()||'main'),",
        "    'state='+(prState||'unknown')+' mergeable='+(String(pr?.mergeable||'').trim()||'unknown')+' reviewDecision='+(String(pr?.reviewDecision||'').trim()||'none'),",
        "    'checks='+checks.length+' pass='+passingChecks.length+' fail='+failingChecks.length+' pending='+pendingChecks.length,",
        "    'comments='+issueComments.length+' reviews='+reviews.length+' reviewComments='+reviewComments.length+' files='+files.length,",
        "    labels.length?'labels='+labels.join(', '):'',",
        "  ].filter(Boolean).join('\\n');",
        "  return {core:{number:Number(pr?.number||prNumber)||prNumber,title:String(pr?.title||fallback?.taskTitle||''),url:String(pr?.url||ctx.prUrl||fallback?.prUrl||'').trim()||null,body:truncateText(pr?.body,4000),branch:String(pr?.headRefName||branch||'').trim()||null,baseBranch:String(pr?.baseRefName||baseBranch||'main').trim()||'main',state:prState||null,mergedAt,isDraft:pr?.isDraft===true,mergeable:String(pr?.mergeable||'').trim()||null,author:compactUser(pr?.author),reviewDecision:String(pr?.reviewDecision||'').trim()||null},labels,requestedReviewers,checks,ciSummary:{total:checks.length,passing:passingChecks.length,failing:failingChecks.length,pending:pendingChecks.length},issueComments,reviews,reviewComments,files,digestSummary};",
        "}",
        "const prDigest=collectPrDigest(ctx||{});",
        "const pr=prDigest.core||{};",
        "const checks=Array.isArray(prDigest.checks)?prDigest.checks:[];",
        "const failStates=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const pendingStates=new Set(['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED']);",
        "const conflictMergeables=new Set(['CONFLICTING','DIRTY','UNKNOWN']);",
        "const failedCheckNames=checks.filter((c)=>{const s=String(c?.state||'').toUpperCase();const b=String(c?.bucket||'').toUpperCase();return failStates.has(s)||b==='FAIL';}).map((c)=>String(c?.name||'').trim()).filter(Boolean);",
        "const hasFailure=checks.some((c)=>{const s=String(c?.state||'').toUpperCase();const b=String(c?.bucket||'').toUpperCase();return failStates.has(s)||b==='FAIL';});",
        "const hasPending=checks.some((c)=>pendingStates.has(String(c?.state||'').toUpperCase()));",
        "let classification='ready';",
        "let reason='ready_for_review';",
        "let ciKicked=false;",
        "const prState=String(pr?.state||'').trim().toUpperCase();",
        "const mergedAt=String(pr?.mergedAt||'').trim()||null;",
        "if(mergedAt||prState==='MERGED'){classification='merged';reason='pr_merged';}",
        "else if(prState==='CLOSED'){classification='closed';reason='pr_closed';}",
        "else if(pr?.isDraft===true){classification='draft';reason='draft_pr';}",
        "else if(conflictMergeables.has(String(pr?.mergeable||'').toUpperCase())){classification='conflict';reason='merge_conflict';}",
        "else if(hasFailure){classification='ci_failure';reason='ci_failed';}",
        "else if(hasPending){classification='pending';reason='ci_pending';}",
        "else if(checks.length===0 && branch){",
        "  try{gh(['workflow','run','ci.yaml','--repo',repo,'--ref',branch]);ciKicked=true;classification='pending';reason='ci_kicked';}",
        "  catch{classification='ready';reason='ready_without_checks';}",
        "}",
        "console.log(JSON.stringify({success:true,repo,prNumber,url:String(pr?.url||ctx.prUrl||''),branch:String(pr?.branch||branch||''),baseBranch:String(pr?.baseBranch||baseBranch||'main'),title:String(pr?.title||ctx.taskTitle||''),mergeable:String(pr?.mergeable||''),reviewDecision:String(pr?.reviewDecision||'').trim()||null,labels:Array.isArray(prDigest.labels)?prDigest.labels:[],classification,reason,ciKicked,hasFailure,hasPending,failedCheckNames,checks,ciSummary:prDigest.ciSummary||null,prDigest,digestSummary:String(prDigest.digestSummary||'')}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_PR_CONTEXT:
          "{{$data?.prProgressContext ? JSON.stringify($data.prProgressContext) : '{}'}}",
      },
    }, { x: 400, y: 430 }),

    node("fix-needed", "condition.expression", "Needs Repair?", {
      expression:
        "(()=>{try{" +
        "const d=JSON.parse($ctx.getNodeOutput('inspect-pr')?.output||'{}');" +
        "return d?.classification==='ci_failure' || d?.classification==='conflict';" +
        "}catch{return false;}})()",
    }, { x: 220, y: 560 }),

    node("programmatic-fix", "action.run_command", "Repair Attempt", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const data=(()=>{try{return JSON.parse(String(process.env.BOSUN_PR_INSPECT||'{}'))}catch{return {}}})();",
        "const repo=String(data.repo||'').trim();",
        "const branch=String(data.branch||'').trim();",
        "const prNumber=Number.parseInt(String(data.prNumber||''),10);",
        "const classification=String(data.classification||'').trim();",
        "const failedCheckNames=Array.isArray(data.failedCheckNames)?data.failedCheckNames:[];",
        "const labelFix=String('{{labelNeedsFix}}'||'bosun-needs-fix');",
        "const FAIL_STATES=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const MAX_AUTO_RERUN_ATTEMPT=1;",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function normalizeRun(run){if(!run||typeof run!=='object')return null;return {databaseId:Number(run.databaseId||0)||null,attempt:Number(run.attempt||0)||0,conclusion:String(run.conclusion||''),status:String(run.status||''),workflowName:String(run.workflowName||run.name||''),displayTitle:String(run.displayTitle||run.name||''),url:String(run.url||''),createdAt:String(run.createdAt||''),updatedAt:String(run.updatedAt||'')}}",
        "function normalizeCheckKey(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}",
        "function runMatchesFailedChecks(run,failedNames){const keys=(Array.isArray(failedNames)?failedNames:[]).map(normalizeCheckKey).filter(Boolean);if(!keys.length)return true;const names=[run?.workflowName,run?.displayTitle].map(normalizeCheckKey).filter(Boolean);return names.some((name)=>keys.some((key)=>name===key||name.includes(key)||key.includes(name)));}",
        "function normalizeJob(job){if(!job||typeof job!=='object')return null;const steps=Array.isArray(job.steps)?job.steps:[];return {databaseId:Number(job.databaseId||job.id||0)||null,name:String(job.name||''),status:String(job.status||''),conclusion:String(job.conclusion||''),url:String(job.url||job.html_url||''),checkRunUrl:String(job.check_run_url||job.checkRunUrl||''),failedSteps:steps.filter((step)=>FAIL_STATES.has(String(step?.conclusion||step?.status||'').toUpperCase())).map((step)=>({name:String(step?.name||''),number:Number(step?.number||0)||null,status:String(step?.status||''),conclusion:String(step?.conclusion||'')})).filter((step)=>step.name).slice(0,10)}}",
        "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
        GITHUB_CI_DIAGNOSTICS_SNIPPET,
        "if(repo&&Number.isFinite(prNumber)&&prNumber>0){",
        "  try{gh(['pr','edit',String(prNumber),'--repo',repo,'--add-label',labelFix]);}catch{}",
        "}",
        "if(classification==='ci_failure'&&repo&&branch){",
        "  try{",
        "    const listRaw=gh(['run','list','--repo',repo,'--branch',branch,'--json','databaseId,attempt,conclusion,status,workflowName,displayTitle,url,createdAt,updatedAt','--limit','8']);",
        "    const runs=(()=>{try{return JSON.parse(listRaw||'[]')}catch{return []}})();",
        "    const normalizedRuns=(Array.isArray(runs)?runs:[]).map(normalizeRun).filter(Boolean);",
        "    const relevantFailedRuns=normalizedRuns.filter((r)=>FAIL_STATES.has(String(r?.conclusion||'').toUpperCase())&&runMatchesFailedChecks(r,failedCheckNames));",
        "    const relevantPendingRuns=normalizedRuns.filter((r)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(String(r?.status||'').toUpperCase())&&runMatchesFailedChecks(r,failedCheckNames));",
        "    const failedRun=relevantFailedRuns[0]||normalizedRuns.find((r)=>FAIL_STATES.has(String(r?.conclusion||'').toUpperCase()));",
        "    const recentFailedRunCount=relevantFailedRuns.length||(failedRun?1:0);",
        "    if(relevantPendingRuns.length){console.log(JSON.stringify({success:true,rerunRequested:false,needsAgent:false,reason:'ci_rerun_pending',failedCheckNames,pendingRuns:relevantPendingRuns.slice(0,5)}));process.exit(0);}",
        "    if(failedRun?.databaseId&&failedRun.attempt<=MAX_AUTO_RERUN_ATTEMPT&&recentFailedRunCount<=MAX_AUTO_RERUN_ATTEMPT){gh(['run','rerun',String(failedRun.databaseId),'--repo',repo]);console.log(JSON.stringify({success:true,rerunRequested:true,needsAgent:false,reason:'rerun_requested',failedCheckNames,failedRun,recentFailedRunCount}));process.exit(0);}",
        "    if(failedRun?.databaseId){const diagnostics=collectCiDiagnostics(repo,failedRun,gh);console.log(JSON.stringify({success:false,rerunRequested:false,needsAgent:true,reason:'auto_rerun_limit_reached',failedCheckNames,rerunAttempts:failedRun.attempt||0,recentFailedRunCount,...diagnostics}));process.exit(0);}",
        "    console.log(JSON.stringify({success:false,rerunRequested:false,needsAgent:true,reason:'no_rerunnable_failed_run_found',failedCheckNames,recentRuns:normalizedRuns.slice(0,5)}));",
        "    process.exit(0);",
        "  }catch(e){",
        "    console.log(JSON.stringify({success:false,rerunRequested:false,needsAgent:true,reason:'ci_rerun_failed',failedCheckNames,error:String(e?.message||e)}));",
        "    process.exit(0);",
        "  }",
        "}",
        "if(classification==='conflict'&&repo&&Number.isFinite(prNumber)&&prNumber>0){",
        "  const mergeable=String(data.mergeable||'').toUpperCase();",
        "  if(mergeable==='BEHIND'){",
        "    try{",
        "      const headSha=JSON.parse(gh(['pr','view',String(prNumber),'--repo',repo,'--json','headRefOid'])).headRefOid;",
        "      gh(['api','-X','PUT','repos/'+repo+'/pulls/'+prNumber+'/update-branch','--field','expected_head_sha='+headSha]);",
        "      console.log(JSON.stringify({success:true,branchUpdated:true,needsAgent:false,reason:'branch_updated_from_base',mergeable}));",
        "      process.exit(0);",
        "    }catch(e){",
        "      console.log(JSON.stringify({success:false,needsAgent:true,reason:'branch_update_failed',mergeable,error:String(e?.message||e)}));",
        "      process.exit(0);",
        "    }",
        "  }",
        "}",
        "console.log(JSON.stringify({success:false,rerunRequested:false,needsAgent:true,reason:classification==='conflict'?'merge_conflict_requires_code_resolution':'repair_required',failedCheckNames}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_PR_INSPECT:
          "{{$ctx.getNodeOutput('inspect-pr')?.output || '{}'}}",
      },
    }, { x: 220, y: 690 }),

    node("fix-agent-needed", "condition.expression", "Needs Fix Agent?", {
      expression:
        "(()=>{try{" +
        "const d=JSON.parse($ctx.getNodeOutput('programmatic-fix')?.output||'{}');" +
        "return d?.needsAgent===true;" +
        "}catch{return false;}})()",
    }, { x: 220, y: 820 }),

    // ── Pre-resolve PR parameters before worktree setup ──────────────────────
    // ctx.resolve() only handles {{template}} syntax — not JavaScript IIFEs.
    // Extract values from inspect-pr output via isExpression so downstream
    // run_command env blocks can reference them as {{prParams.X}}.
    node("resolve-pr-params", "action.set_variable", "Resolve PR Parameters", {
      key: "prParams",
      value:
        "(()=>{" +
        "const raw=$ctx?.getNodeOutput?.('inspect-pr')?.output||'{}';" +
        "const d=typeof raw==='object'?raw:(()=>{try{return JSON.parse(raw)}catch{return {}}})();" +
        "const ctx=$data?.prProgressContext||{};" +
        "return {" +
        "repo:String(d.repo||d.prDigest?.core?.repo||ctx.repo||'')," +
        "branch:String(d.branch||d.prDigest?.core?.branch||ctx.branch||'')," +
        "base:String(d.baseBranch||d.prDigest?.core?.baseBranch||ctx.baseBranch||'main')," +
        "number:String(d.prNumber||d.prDigest?.core?.number||ctx.prNumber||'0')," +
        "classification:String(d.classification||'')," +
        "mergeable:String(d.mergeable||d.prDigest?.core?.mergeable||'')" +
        "};" +
        "})()",
      isExpression: true,
    }, { x: 220, y: 850 }),

    // ── Programmatic worktree setup for fix agent ────────────────────────────
    // Clones (or reuses) a temp checkout on the PR's actual HEAD branch so the
    // agent works in-place on the correct branch — no synthetic branches.
    node("setup-pr-worktree", "action.run_command", "Clone & Checkout PR Branch", {
      command: "node",
      args: ["-e", [
        "const os=require('os');",
        "const path=require('path');",
        "const fs=require('fs');",
        "const {execFileSync}=require('child_process');",
        "const repo=String(process.env.PR_REPO||'').trim();",
        "const branch=String(process.env.PR_BRANCH||'').trim();",
        "const base=String(process.env.PR_BASE||'main').trim();",
        "const num=String(process.env.PR_NUMBER||'0').trim();",
        "if(!repo||!branch){console.log(JSON.stringify({error:'missing repo or branch',repo,branch}));process.exit(1);}",
        "let wt=path.join(os.tmpdir(),'bosun-progfix-'+num.replace(/[^0-9a-z]/gi,'-'));",
        "let reused=false;",
        "if(fs.existsSync(path.join(wt,'.git'))){",
        "  try{",
        "    const cur=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "    if(cur===branch){",
        "      execFileSync('git',['fetch','origin',branch],{cwd:wt,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});",
        "      execFileSync('git',['reset','--hard','origin/'+branch],{cwd:wt,encoding:'utf8',timeout:30000});",
        "      execFileSync('git',['clean','-fd','-e','.bosun/'],{cwd:wt,encoding:'utf8',timeout:30000});",
        "      try{execFileSync('git',['fetch','origin',base],{cwd:wt,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});}catch{}",
        "      reused=true;",
        "    }else{try{fs.rmSync(wt,{recursive:true,force:true});}catch{}}",
        "  }catch{try{fs.rmSync(wt,{recursive:true,force:true});}catch{}}",
        "}",
        "if(!reused){",
        "  if(fs.existsSync(wt)){try{fs.rmSync(wt,{recursive:true,force:true});}catch{wt=wt+'-'+Date.now().toString(36);}}",
        "  execFileSync('gh',['repo','clone',repo,wt,'--','--branch',branch],{encoding:'utf8',timeout:300000,stdio:'inherit'});",
        "  execFileSync('git',['fetch','origin',branch],{cwd:wt,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});",
        "  execFileSync('git',['reset','--hard','origin/'+branch],{cwd:wt,encoding:'utf8',timeout:30000});",
        "  try{execFileSync('git',['fetch','origin',base],{cwd:wt,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});}catch{}",
        "}",
        "const finalBranch=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "if(finalBranch!==branch){console.error('Branch mismatch: expected '+branch+' got '+finalBranch);process.exit(1);}",
        "console.log(JSON.stringify({worktreePath:wt,branch:finalBranch,base,repo,number:num,reused}));",
      ].join(" ")],
      parseJson: true,
      failOnError: true,
      timeoutMs: 600_000,
      env: {
        PR_REPO:   "{{prParams.repo}}",
        PR_BRANCH: "{{prParams.branch}}",
        PR_BASE:   "{{prParams.base}}",
        PR_NUMBER: "{{prParams.number}}",
      },
    }, { x: 220, y: 880 }),

    node("set-pr-worktree-path", "action.set_variable", "Set Agent Working Directory", {
      key: "worktreePath",
      value: "{{setup-pr-worktree.output.worktreePath}}",
    }, { x: 220, y: 920 }),

    // ── Detect specific merge conflict files in worktree ─────────────────────
    node("detect-pr-conflicts", "action.run_command", "Detect Merge Conflict Files", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const wt=String(process.env.WORKTREE_PATH||'').trim();",
        "const base=String(process.env.PR_BASE||'main').trim();",
        "const classification=String(process.env.CLASSIFICATION||'').trim();",
        "const mergeable=String(process.env.MERGEABLE||'').trim().toUpperCase();",
        "if(!wt){console.log(JSON.stringify({hasConflicts:false,conflictFiles:[]}));process.exit(0);}",
        "const isConflict=classification==='conflict'||['CONFLICTING','DIRTY'].includes(mergeable);",
        "if(!isConflict){console.log(JSON.stringify({hasConflicts:false,conflictFiles:[]}));process.exit(0);}",
        "let mergeOutput='';",
        "let conflictFiles=[];",
        "try{",
        "  try{mergeOutput=execFileSync('git',['merge','--no-commit','--no-ff','origin/'+base],{cwd:wt,encoding:'utf8',timeout:60000}).toString();}",
        "  catch(e){mergeOutput=String(e?.stderr||'')+' '+String(e?.stdout||'');}",
        "  try{",
        "    const diffFiles=execFileSync('git',['diff','--name-only','--diff-filter=U'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "    if(diffFiles){conflictFiles=diffFiles.split(/\\r?\\n/).map(f=>f.trim()).filter(Boolean);}",
        "  }catch{}",
        "  if(conflictFiles.length===0){",
        "    const matches=mergeOutput.match(/CONFLICT[^:]*:\\s*Merge conflict in (.+)/gi)||[];",
        "    conflictFiles=matches.map(m=>{const f=m.match(/in\\s+(.+)/i);return f?f[1].trim():'';}).filter(Boolean);",
        "  }",
        "  try{execFileSync('git',['merge','--abort'],{cwd:wt,timeout:10000});}catch{}",
        "}catch(e){",
        "  try{execFileSync('git',['merge','--abort'],{cwd:wt,timeout:10000});}catch{}",
        "  console.log(JSON.stringify({hasConflicts:false,conflictFiles:[],error:String(e?.message||e).slice(0,500)}));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({hasConflicts:conflictFiles.length>0,conflictFiles:[...new Set(conflictFiles)],mergeOutput:String(mergeOutput||'').slice(0,2000)}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      timeoutMs: 120_000,
      env: {
        WORKTREE_PATH:  "{{setup-pr-worktree.output.worktreePath}}",
        PR_BASE:        "{{prParams.base}}",
        CLASSIFICATION: "{{prParams.classification}}",
        MERGEABLE:      "{{prParams.mergeable}}",
      },
    }, { x: 220, y: 940 }),

    // ── Build structured agent prompt (like a human reviewer comment) ────────
    node("build-fix-prompt", "action.set_variable", "Build Structured Fix Prompt", {
      key: "agentPrompt",
      value: "(()=>{\n" +
        "  const inspectRaw = $ctx?.getNodeOutput?.('inspect-pr')?.output || '{}';\n" +
        "  const fixRaw = $ctx?.getNodeOutput?.('programmatic-fix')?.output || '{}';\n" +
        "  const conflictRaw = $ctx?.getNodeOutput?.('detect-pr-conflicts')?.output || '{}';\n" +
        "  const inspect = (()=>{ try { return typeof inspectRaw === 'object' ? inspectRaw : JSON.parse(inspectRaw); } catch { return {}; } })();\n" +
        "  const fix = (()=>{ try { return typeof fixRaw === 'object' ? fixRaw : JSON.parse(fixRaw); } catch { return {}; } })();\n" +
        "  const conflictDetection = (()=>{ try { return typeof conflictRaw === 'object' ? conflictRaw : JSON.parse(conflictRaw); } catch { return {}; } })();\n" +
        "  const prDigest = inspect.prDigest || {};\n" +
        "  const core = prDigest.core || {};\n" +
        "  const repo = String(inspect.repo || core.repo || $data?.prProgressContext?.repo || '');\n" +
        "  const branch = String(inspect.branch || core.branch || $data?.prProgressContext?.branch || '');\n" +
        "  const base = String(inspect.baseBranch || core.baseBranch || $data?.prProgressContext?.baseBranch || 'main');\n" +
        "  const number = String(inspect.prNumber || core.number || $data?.prProgressContext?.prNumber || '');\n" +
        "  const title = String(inspect.title || core.title || $data?.prProgressContext?.taskTitle || '');\n" +
        "  const url = String(inspect.url || core.url || $data?.prProgressContext?.prUrl || '');\n" +
        "  const classification = String(inspect.classification || '');\n" +
        "  const reason = String(fix.reason || classification || '');\n" +
        "  const mergeable = String(inspect.mergeable || core.mergeable || '');\n" +
        "  const failedChecks = Array.isArray(inspect.failedCheckNames) ? inspect.failedCheckNames : [];\n" +
        "  const failedJobs = Array.isArray(fix.failedJobs) ? fix.failedJobs : [];\n" +
        "  const annotations = Array.isArray(fix.failedAnnotations) ? fix.failedAnnotations : [];\n" +
        "  const logExcerpt = String(fix.failedLogExcerpt || '').trim();\n" +
        "  const recentRuns = Array.isArray(fix.recentRuns) ? fix.recentRuns : [];\n" +
        "  const ciSummary = prDigest.ciSummary || inspect.ciSummary || {};\n" +
        "  const prBody = String(core.body || '').trim();\n" +
        "  const files = Array.isArray(prDigest.files) ? prDigest.files : [];\n" +
        "  const reviews = Array.isArray(prDigest.reviews) ? prDigest.reviews : [];\n" +
        "  const reviewComments = Array.isArray(prDigest.reviewComments) ? prDigest.reviewComments : [];\n" +
        "  const issueComments = Array.isArray(prDigest.issueComments) ? prDigest.issueComments : [];\n" +
        "  const allChecks = Array.isArray(prDigest.checks) ? prDigest.checks : [];\n" +
        "  const detectedConflictFiles = Array.isArray(conflictDetection?.conflictFiles) ? conflictDetection.conflictFiles : [];\n" +
        "  const persistedReviewIssues = Array.isArray($data?.prProgressContext?.reviewIssues) ? $data.prProgressContext.reviewIssues : [];\n" +
        "  const persistedReviewIssueCount = Number($data?.prProgressContext?.reviewIssueCount || persistedReviewIssues.length || 0) || 0;\n" +
        "  const reviewFixDispatchMode = String($data?.prProgressContext?.reviewFixDispatchMode || '').trim();\n" +
        "  const reviewFixRequestedAt = String($data?.prProgressContext?.reviewFixRequestedAt || '').trim();\n" +
        "  let p = 'You are a Bosun PR repair agent. Your ONLY job is to fix this single PR.\\n\\n';\n" +
        "  p += '## PR Identity\\n\\n';\n" +
        "  p += '- **Repo**: ' + repo + '\\n';\n" +
        "  p += '- **PR Number**: #' + number + '\\n';\n" +
        "  p += '- **Title**: ' + title + '\\n';\n" +
        "  p += '- **URL**: ' + url + '\\n';\n" +
        "  p += '- **Head Branch**: `' + branch + '`\\n';\n" +
        "  p += '- **Base Branch**: `' + base + '`\\n';\n" +
        "  p += '- **Fix Reason**: `' + reason + '`\\n';\n" +
        "  if (mergeable) p += '- **Merge State**: ' + mergeable + '\\n';\n" +
        "  if (fix.error) p += '- **Error**: ' + fix.error + '\\n';\n" +
        "  if (reviewFixDispatchMode) p += '- **Review Fix Dispatch Mode**: `' + reviewFixDispatchMode + '`\\n';\n" +
        "  if (reviewFixRequestedAt) p += '- **Review Fix Requested At**: ' + reviewFixRequestedAt + '\\n';\n" +
        "  p += '\\n';\n" +
        "  /* --- Fix Summary --- */\n" +
        "  const changesRequestedReviews = reviews.filter(r => String(r.state||'').toUpperCase() === 'CHANGES_REQUESTED');\n" +
        "  const actionableInlineComments = reviewComments.filter(c => c.body && c.body.trim());\n" +
        "  const actionableIssueComments = issueComments.filter(c => c.body && /(fix|please|should|must|needs?|issue|bug|error|warning|lint|suggest|change|request|fail|todo|nit|@copilot)/i.test(c.body));\n" +
        "  const fixItems = [];\n" +
        "  if (mergeable.toUpperCase() === 'CONFLICTING' || mergeable.toUpperCase() === 'DIRTY' || detectedConflictFiles.length > 0) fixItems.push('**Merge conflicts** — ' + (detectedConflictFiles.length > 0 ? detectedConflictFiles.length + ' files: ' + detectedConflictFiles.map(f => '`' + f + '`').join(', ') : 'resolve all conflicts with base `' + base + '`'));\n" +
        "  if (failedChecks.length > 0 || logExcerpt) fixItems.push('**CI/CD failures** — ' + (failedChecks.length > 0 ? failedChecks.length + ' failing checks: ' + failedChecks.map(n => '`' + n + '`').join(', ') : 'see log excerpt below'));\n" +
        "  if (changesRequestedReviews.length > 0 || actionableInlineComments.length > 0 || actionableIssueComments.length > 0) fixItems.push('**Review feedback** — ' + [changesRequestedReviews.length > 0 ? changesRequestedReviews.length + ' change request(s)' : '', actionableInlineComments.length > 0 ? actionableInlineComments.length + ' inline comment(s)' : '', actionableIssueComments.length > 0 ? actionableIssueComments.length + ' issue comment(s)' : ''].filter(Boolean).join(', '));\n" +
        "  if (persistedReviewIssueCount > 0) fixItems.push('**Persisted review issues** — ' + persistedReviewIssueCount + ' issue(s) preserved from supervisor redispatch');\n" +
        "  if (fixItems.length > 0) {\n" +
        "    p += '## Fix Summary\\n\\nThis PR needs the following fixes:\\n';\n" +
        "    fixItems.forEach((item, i) => { p += (i+1) + '. ' + item + '\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (persistedReviewIssues.length > 0) {\n" +
        "    p += '## Persisted Review Issues\\n\\n';\n" +
        "    persistedReviewIssues.slice(0, 12).forEach((issue, index) => {\n" +
        "      const severity = String(issue?.severity || 'major');\n" +
        "      const category = String(issue?.category || 'review');\n" +
        "      const file = String(issue?.file || '(unknown)');\n" +
        "      const line = Number(issue?.line || 0) > 0 ? ':' + String(issue.line) : '';\n" +
        "      const description = String(issue?.description || issue?.message || '').trim();\n" +
        "      p += (index + 1) + '. [' + severity + '/' + category + '] `' + file + line + '`';\n" +
        "      if (description) p += ' - ' + description;\n" +
        "      p += '\\n';\n" +
        "    });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (mergeable.toUpperCase() === 'CONFLICTING' || mergeable.toUpperCase() === 'DIRTY' || detectedConflictFiles.length > 0) {\n" +
        "    p += '## Merge Conflict\\n\\n';\n" +
        "    p += 'This branch has conflicts that must be resolved.\\n';\n" +
        "    p += 'Merge `origin/' + base + '` into `' + branch + '` and resolve all conflicts.\\n\\n';\n" +
        "    if (detectedConflictFiles.length > 0) {\n" +
        "      p += '**Conflicting files:**\\n';\n" +
        "      detectedConflictFiles.forEach(f => { p += '- `' + f + '`\\n'; });\n" +
        "      p += '\\n';\n" +
        "    }\n" +
        "  }\n" +
        "  if (failedChecks.length > 0) {\n" +
        "    p += '## Failed CI Checks\\n\\n';\n" +
        "    failedChecks.forEach(n => { p += '- `' + n + '`\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (ciSummary.total > 0 || ciSummary.failing > 0) {\n" +
        "    p += '## CI Check Summary\\n\\n';\n" +
        "    p += 'Total: ' + (ciSummary.total||0) + ' | Failing: ' + (ciSummary.failing||0) + ' | Pending: ' + (ciSummary.pending||0) + ' | Passing: ' + (ciSummary.passing||0) + '\\n\\n';\n" +
        "  }\n" +
        "  if (fix.failedRun) {\n" +
        "    const run = fix.failedRun;\n" +
        "    p += '## Failed Workflow Run\\n\\n';\n" +
        "    p += '- **Workflow**: ' + (run.workflowName || run.displayTitle || '') + '\\n';\n" +
        "    p += '- **Run ID**: ' + run.databaseId + '\\n';\n" +
        "    p += '- **Conclusion**: ' + run.conclusion + '\\n';\n" +
        "    if (run.url) p += '- **URL**: ' + run.url + '\\n';\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (failedJobs.length > 0) {\n" +
        "    p += '## Failed Jobs\\n\\n';\n" +
        "    failedJobs.slice(0,8).forEach(job => {\n" +
        "      p += '### ' + (job.name||'unknown') + '\\n';\n" +
        "      p += '- Conclusion: ' + job.conclusion + '\\n';\n" +
        "      if (job.url) p += '- URL: ' + job.url + '\\n';\n" +
        "      if (Array.isArray(job.failedSteps) && job.failedSteps.length > 0) {\n" +
        "        p += '- Failed steps: ' + job.failedSteps.map(s => '`' + s.name + '`').join(', ') + '\\n';\n" +
        "      }\n" +
        "      p += '\\n';\n" +
        "    });\n" +
        "  }\n" +
        "  if (annotations.length > 0) {\n" +
        "    p += '## Code Annotations (Errors / Warnings)\\n\\n';\n" +
        "    annotations.slice(0,6).forEach(annot => {\n" +
        "      if (Array.isArray(annot.annotations) && annot.annotations.length > 0) {\n" +
        "        p += '**Job: ' + (annot.name||'') + '**\\n';\n" +
        "        annot.annotations.slice(0,15).forEach(a => {\n" +
        "          p += '- `' + (a.path||'') + ':' + (a.startLine||'') + '` **' + (a.title||a.level||'error') + '**: ' + (a.message||'') + '\\n';\n" +
        "        });\n" +
        "        p += '\\n';\n" +
        "      }\n" +
        "    });\n" +
        "  }\n" +
        "  if (logExcerpt) {\n" +
        "    p += '## CI Log Excerpt (Failed Steps)\\n\\n```\\n' + logExcerpt.slice(0,10000) + '\\n```\\n\\n';\n" +
        "  }\n" +
        "  if (prBody) {\n" +
        "    p += '## PR Description\\n\\n' + prBody.slice(0,2000) + '\\n\\n';\n" +
        "  }\n" +
        "  if (files.length > 0) {\n" +
        "    p += '## Changed Files (' + files.length + ')\\n\\n';\n" +
        "    files.slice(0,40).forEach(f => { p += '- `' + f.path + '` (+' + (f.additions||0) + '/-' + (f.deletions||0) + ')\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  const reviewsWithBody = reviews.filter(r => r.body && r.body.trim());\n" +
        "  if (reviewsWithBody.length > 0 || reviewComments.length > 0) {\n" +
        "    p += '## Reviews & Inline Comments\\n\\n';\n" +
        "    reviewsWithBody.slice(0,5).forEach(r => {\n" +
        "      p += '**' + (r.author?.login||'reviewer') + '** (' + r.state + '): ' + r.body.slice(0,400) + '\\n\\n';\n" +
        "    });\n" +
        "    if (reviewComments.length > 0) {\n" +
        "      p += 'Inline comments:\\n';\n" +
        "      reviewComments.slice(0,12).forEach(c => {\n" +
        "        p += '- `' + (c.path||'') + ':' + (c.line||'') + '` (' + (c.author?.login||'') + '): ' + (c.body||'').slice(0,250) + '\\n';\n" +
        "      });\n" +
        "      p += '\\n';\n" +
        "    }\n" +
        "  }\n" +
        "  const issueCommentsWithBody = issueComments.filter(c => c.body && c.body.trim());\n" +
        "  if (issueCommentsWithBody.length > 0) {\n" +
        "    p += '## Issue Comments\\n\\n';\n" +
        "    issueCommentsWithBody.slice(0,5).forEach(c => {\n" +
        "      p += '**' + (c.author?.login||'user') + '**: ' + c.body.slice(0,300) + '\\n\\n';\n" +
        "    });\n" +
        "  }\n" +
        "  return p;\n" +
        "})()",
      isExpression: true,
    }, { x: 220, y: 950 }),

    node("mark-active", "action.set_variable", "Mark Agent Workflow Active", {
      key: "_agentWorkflowActive",
      value: "true",
      isExpression: true,
    }, { x: 220, y: 980 }),

    node("dispatch-fix-agent", "action.run_agent", "Dispatch Focused Fix Agent", {
      prompt:
        "{{agentPrompt}}\n\n" +
        "## Workspace\n\n" +
        "Your working directory is already a git clone of the target repo, " +
        "checked out on the PR's HEAD branch (`{{setup-pr-worktree.output.branch}}`). " +
        "The base branch (`origin/{{setup-pr-worktree.output.base}}`) has been fetched.\n\n" +
        "## CRITICAL RULES — READ BEFORE DOING ANYTHING\n\n" +
        "1. **Do NOT clone or re-clone the repo** — you are already in it.\n" +
        "2. **Do NOT create new branches.** Stay on the current branch.\n" +
        "3. **Do NOT push.** The workflow pushes for you automatically after you finish.\n" +
        "4. **Do NOT switch branches** with `git checkout` or `git switch`.\n" +
        "5. **Do NOT run `cd` to change to a different directory.** Stay in the cwd.\n" +
        "6. Fix ONLY the specific issues listed in the Fix Summary above.\n" +
        "7. Do NOT merge, approve, or close the PR.\n" +
        "8. Do NOT touch any other PRs or repos.\n\n" +
        "## Fix Instructions\n\n" +
        "Use prDigest.body, prDigest.files, prDigest.issueComments, prDigest.reviews, " +
        "prDigest.reviewComments, prDigest.checks, failedAnnotations, and any " +
        "failedLogExcerpt before making changes.\n" +
        "Use the PR digest (CI diagnostics, log excerpts, annotations, reviews) " +
        "above to identify the root cause and apply the MINIMAL fix.\n\n" +
        "- For merge conflicts: `git merge origin/{{setup-pr-worktree.output.base}}` and resolve.\n" +
        "- For CI failures: study the error output and apply the MINIMAL code fix.\n" +
        "- For review feedback: address each comment precisely.\n" +
        "- After fixing, remove the label:\n" +
        "  `gh pr edit {{setup-pr-worktree.output.number}} --repo {{setup-pr-worktree.output.repo}} --remove-label bosun-needs-fix`\n",
      sdk: "auto",
      timeoutMs: 1_800_000,
      delegationWatchdogTimeoutMs: "{{delegationWatchdogTimeoutMs}}",
      delegationWatchdogMaxRecoveries: "{{delegationWatchdogMaxRecoveries}}",
      maxRetries: 2,
      retryDelayMs: 30_000,
      continueOnError: true,
    }, { x: 220, y: 970 }),

    // ── Push agent changes on the correct branch ─────────────────────────────
    node("push-pr-fixes", "action.run_command", "Push Fixes to PR Branch", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const wt=String(process.env.WORKTREE_PATH||'').trim();",
        "const expectedBranch=String(process.env.PR_BRANCH||'').trim();",
        "const allowPush=!/^(0|false|no|off|disabled)$/i.test(String(process.env.ALLOW_PUSH||'true').trim()||'true');",
        "if(!wt){console.log(JSON.stringify({pushed:false,reason:'no worktree path'}));process.exit(0);}",
        "if(!allowPush){console.log(JSON.stringify({pushed:false,reason:'push_disabled'}));process.exit(0);}",
        "const branch=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "if(expectedBranch&&branch!==expectedBranch){console.log(JSON.stringify({pushed:false,reason:'branch mismatch',expected:expectedBranch,actual:branch}));process.exit(1);}",
        "const status=execFileSync('git',['status','--porcelain'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "const diff=execFileSync('git',['diff','--stat','HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "const ahead=execFileSync('git',['rev-list','--count','origin/'+branch+'..HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "if(!status&&!diff&&ahead==='0'){console.log(JSON.stringify({pushed:false,reason:'nothing to push'}));process.exit(0);}",
        "if(status){execFileSync('git',['add','-A'],{cwd:wt,timeout:30000});execFileSync('git',['commit','-m','fix: bosun PR repair (progressor)'],{cwd:wt,timeout:30000});}",
        "execFileSync('git',['push','--force-with-lease','origin',branch],{cwd:wt,encoding:'utf8',timeout:120000,stdio:'inherit'});",
        "console.log(JSON.stringify({pushed:true,branch}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      timeoutMs: 300_000,
      env: {
        WORKTREE_PATH: "{{setup-pr-worktree.output.worktreePath}}",
        PR_BRANCH:     "{{setup-pr-worktree.output.branch}}",
        ALLOW_PUSH:    "{{allowPush}}",
      },
    }, { x: 220, y: 1020 }),

    // ── Cleanup temp clone ───────────────────────────────────────────────────
    node("cleanup-pr-worktree", "action.run_command", "Cleanup Temp Clone", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const wt=String(process.env.WORKTREE_PATH||'').trim();",
        "if(wt&&fs.existsSync(wt)){try{fs.rmSync(wt,{recursive:true,force:true});console.log('cleaned up '+wt);}catch(e){console.warn('cleanup failed: '+e.message);}}",
        "else{console.log('nothing to clean');}",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      timeoutMs: 60_000,
      env: {
        WORKTREE_PATH: "{{setup-pr-worktree.output.worktreePath}}",
      },
    }, { x: 220, y: 1060 }),

    // ── Update sibling PR branches after push (so other PRs stay up-to-date) ─
    node("update-sibling-branches", "action.run_command", "Update Sibling PR Branches", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const repo=String(process.env.REPO||'').trim();",
        "const thisPrNumber=String(process.env.THIS_PR||'').trim();",
        "const base=String(process.env.BASE_BRANCH||'main').trim();",
        "const allowPush=!/^(0|false|no|off|disabled)$/i.test(String(process.env.ALLOW_PUSH||'true').trim()||'true');",
        "if(!repo){console.log(JSON.stringify({updated:0,reason:'no repo'}));process.exit(0);}",
        "if(!allowPush){console.log(JSON.stringify({updated:0,reason:'push_disabled'}));process.exit(0);}",
        "let prs=[];",
        "try{prs=JSON.parse(execFileSync('gh',['pr','list','--repo',repo,'--base',base,'--state','open','--json','number,headRefOid','--limit','50'],{encoding:'utf8',timeout:30000}));}",
        "catch(e){console.log(JSON.stringify({updated:0,error:String(e?.message||e).slice(0,200)}));process.exit(0);}",
        "let updated=0,failed=0;",
        "for(const pr of prs){",
        "  if(String(pr.number)===thisPrNumber)continue;",
        "  try{",
        "    execFileSync('gh',['api','-X','PUT','repos/'+repo+'/pulls/'+pr.number+'/update-branch','--field','expected_head_sha='+pr.headRefOid],{encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30000});",
        "    updated++;console.log('Updated PR #'+pr.number);",
        "  }catch(e){",
        "    const msg=String(e?.stderr||e?.message||e);",
        "    if(/already up/i.test(msg)||/merge conflict/i.test(msg)){continue;}",
        "    failed++;console.log('Skip PR #'+pr.number+': '+msg.slice(0,150));",
        "  }",
        "}",
        "console.log(JSON.stringify({updated,failed,total:prs.length}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      timeoutMs: 180_000,
      env: {
        REPO: "{{prParams.repo}}",
        THIS_PR: "{{prParams.number}}",
        BASE_BRANCH: "{{prParams.base}}",
        ALLOW_PUSH: "{{allowPush}}",
      },
    }, { x: 220, y: 1080 }),

    node("review-needed", "condition.expression", "Ready For Review?", {
      expression:
        "(()=>{try{" +
        "const d=JSON.parse($ctx.getNodeOutput('inspect-pr')?.output||'{}');" +
        "return d?.classification==='ready';" +
        "}catch{return false;}})()",
    }, { x: 620, y: 560 }),

    node("programmatic-review", "action.run_command", "Review Gate: Merge Single PR", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        GH_CLI_RESILIENCE_SNIPPET,
        "const pr=(()=>{try{return JSON.parse(String(process.env.BOSUN_PR_INSPECT||'{}'))}catch{return {}}})();",
        "const repo=String(pr.repo||'').trim();",
        "const n=String(pr.prNumber||'').trim();",
        "const ratio=Number('{{suspiciousDeletionRatio}}')||3;",
        "const minDel=Number('{{minDestructiveDeletions}}')||500;",
        "const labelReview=String('{{labelNeedsReview}}'||'bosun-needs-human-review');",
        "const method=String('{{mergeMethod}}'||'merge').toLowerCase();",
        "if(!repo||!n){console.log(JSON.stringify({mergedCount:0,heldCount:0,skippedCount:1,skipped:[{repo,number:n,reason:'missing_repo_or_pr'}]}));process.exit(0);}",
        "try{",
        "  const view=safeGhJson(['pr','view',n,'--repo',repo,'--json','number,title,additions,deletions,changedFiles,isDraft'],{});",
        "  if(view?.isDraft===true){console.log(JSON.stringify({mergedCount:0,heldCount:0,skippedCount:1,skipped:[{repo,number:n,reason:'draft'}]}));process.exit(0);}",
        "  const add=Number(view?.additions||0);",
        "  const del=Number(view?.deletions||0);",
        "  const changed=Number(view?.changedFiles||0);",
        "  const destructive=(del>(add*ratio))&&(del>minDel);",
        "  const tooWide=changed>250;",
        "  if(destructive||tooWide){",
        "    runGh(['pr','edit',n,'--repo',repo,'--add-label',labelReview]);",
        "    runGh(['pr','comment',n,'--repo',repo,'--body',':warning: Bosun held this PR for human review due to suspicious diff footprint.']);",
        "    console.log(JSON.stringify({mergedCount:0,heldCount:1,skippedCount:0,held:[{repo,number:n,reason:destructive?'destructive_diff':'changed_files_too_large',additions:add,deletions:del,changedFiles:changed}]}));",
        "    process.exit(0);",
        "  }",
        "  const checks=safeGhJson(['pr','checks',n,'--repo',repo,'--json','name,state,bucket'],[]);",
        "  const hasFailure=(Array.isArray(checks)?checks:[]).some((x)=>{const s=String(x?.state||'').toUpperCase();const b=String(x?.bucket||'').toUpperCase();return ['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(s)||b==='FAIL';});",
        "  const hasPending=(Array.isArray(checks)?checks:[]).some((x)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(String(x?.state||'').toUpperCase()));",
        "  if(hasFailure){console.log(JSON.stringify({mergedCount:0,heldCount:0,skippedCount:1,skipped:[{repo,number:n,reason:'ci_failed'}]}));process.exit(0);}",
        "  if(hasPending){console.log(JSON.stringify({mergedCount:0,heldCount:0,skippedCount:1,skipped:[{repo,number:n,reason:'ci_pending'}]}));process.exit(0);}",
        "  const mergeArgs=['pr','merge',n,'--repo',repo,'--delete-branch'];",
        "  if(method==='rebase') mergeArgs.push('--rebase');",
        "  else if(method==='merge') mergeArgs.push('--merge');",
        "  else mergeArgs.push('--squash');",
        "  try{runGh(mergeArgs);}catch(directErr){mergeArgs.push('--auto');runGh(mergeArgs);}",
        "  console.log(JSON.stringify({mergedCount:1,heldCount:0,skippedCount:0,merged:[{repo,number:n,title:String(view?.title||'')}] }));",
        "}catch(e){",
        "  console.log(JSON.stringify({mergedCount:0,heldCount:1,skippedCount:0,held:[{repo,number:n,reason:'merge_attempt_failed',error:String(e?.message||e)}]}));",
        "}",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_PR_INSPECT:
          "{{$ctx.getNodeOutput('inspect-pr')?.output || '{}'}}",
      },
    }, { x: 620, y: 690 }),

    node("mark-done-merged", "action.update_task_status", "Mark Task Done (Merged PR)", {
      taskId: "{{taskId}}",
      status: "done",
      taskTitle: "{{taskTitle}}",
    }, { x: 780, y: 820 }),

    node("log-deferred", "notify.log", "Deferred", {
      message:
        "Bosun PR Progressor deferred PR #{{prProgressContext.prNumber}}: {{$ctx.getNodeOutput('inspect-pr')?.output || '{}'}}",
      level: "info",
    }, { x: 620, y: 820 }),

    node("log-missing", "notify.log", "Missing PR Context", {
      message: "Bosun PR Progressor skipped: missing PR context for task {{taskId}}",
      level: "warn",
    }, { x: 400, y: 560 }),

    node("notify-complete", "notify.log", "Log Outcome", {
      message:
        "Bosun PR Progressor finished for task {{taskId}} / PR {{prProgressContext.prNumber}}",
      level: "info",
    }, { x: 400, y: 1090 }),
  ],
  edges: [
    edge("trigger", "normalize-context"),
    edge("normalize-context", "has-pr-target"),
    edge("has-pr-target", "inspect-pr", { condition: "$output?.result === true" }),
    edge("has-pr-target", "log-missing", { condition: "$output?.result !== true" }),
    edge("inspect-pr", "fix-needed"),
    edge("fix-needed", "programmatic-fix", { condition: "$output?.result === true" }),
    edge("fix-needed", "review-needed", { condition: "$output?.result !== true" }),
    edge("programmatic-fix", "fix-agent-needed"),
    edge("fix-agent-needed", "resolve-pr-params", { condition: "$output?.result === true" }),
    edge("fix-agent-needed", "notify-complete", { condition: "$output?.result !== true" }),
    edge("resolve-pr-params", "setup-pr-worktree"),
    edge("setup-pr-worktree", "set-pr-worktree-path"),
    edge("set-pr-worktree-path", "detect-pr-conflicts"),
    edge("detect-pr-conflicts", "build-fix-prompt"),
    edge("build-fix-prompt", "mark-active"),
    edge("mark-active", "dispatch-fix-agent"),
    edge("dispatch-fix-agent", "push-pr-fixes"),
    edge("push-pr-fixes", "cleanup-pr-worktree"),
    edge("cleanup-pr-worktree", "update-sibling-branches"),
    edge("update-sibling-branches", "notify-complete"),
    edge("review-needed", "programmatic-review", { condition: "$output?.result === true" }),
    edge("review-needed", "mark-done-merged", {
      condition:
        "$output?.result !== true && (()=>{try{const d=JSON.parse($ctx.getNodeOutput('inspect-pr')?.output||'{}');return d?.classification==='merged';}catch{return false;}})()",
    }),
    edge("review-needed", "log-deferred", {
      condition:
        "$output?.result !== true && (()=>{try{const d=JSON.parse($ctx.getNodeOutput('inspect-pr')?.output||'{}');return d?.classification!=='merged';}catch{return true;}})()",
    }),
    edge("mark-done-merged", "notify-complete"),
    edge("programmatic-review", "notify-complete"),
    edge("log-deferred", "notify-complete"),
    edge("log-missing", "notify-complete"),
  ],
  metadata: {
    author: "bosun",
    version: 6,
    createdAt: "2026-03-30T00:00:00Z",
    templateVersion: "6.0.0",
    tags: ["github", "pr", "handoff", "progression", "event-driven", "worktree-managed"],
    changelog: [
      "v6.0: Set _agentWorkflowActive to prevent delegation to Backend Agent.",
      "v5.0: Set _agentWorkflowActive to prevent delegation to Backend Agent.",
      "v3.0: Structured agent prompt with Fix Summary, specific conflict files, " +
      "CI diagnostics, and actionable review signals — matching human-quality context.",
      "v2.0: Programmatic worktree setup + push. Agent no longer manages " +
      "git state directly — fixes the live-pr-XXX synthetic branch problem.",
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Bosun PR Watchdog
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

/**
 * Bosun PR Watchdog — opt-in, scheduled CI poller for Bosun-created PRs.
 *
 * Uses `bosun-attached` as the low-trust observation marker, but defaults all
 * high-risk actions to PRs with Bosun-created provenance in the PR body.
 * Human-authored PRs are only included when the operator explicitly trusts
 * their login in `prAutomation.trustedAuthors` and enables the relevant mode.
 *
 * Per cycle:
 *   1. List all open bosun-attached PRs.
 *   2. Merge any PR whose CI checks are all passing (not draft, not pending).
 *   3. Label any PR whose CI checks have failures with `bosun-needs-fix` and
 *      dispatch a repair agent to fix the branch.
 *   4. Route CodeQL/code-scanning failures through a dedicated security repair
 *      branch so security findings are fixed instead of treated as generic CI.
 *
 * Disable:  set `enabled: false` in your bosun config, or delete the workflow.
 * Interval: default 90s — change `intervalMs`.
 */
export const BOSUN_PR_WATCHDOG_TEMPLATE = {
  id: "template-bosun-pr-watchdog",
  name: "Bosun PR Watchdog",
  description:
    "Scans open bosun-attached PRs on a schedule. Makes one gh pr list call " +
    "per target repo to fetch and classify PRs, then: labels conflicting or failing-CI PRs " +
    "with bosun-needs-fix and dispatches a repair agent; sends merge candidates " +
    "through a MANDATORY agent review gate that checks diff stats before any " +
    "merge — preventing destructive PRs (e.g. -183k lines) from being silently " +
    "auto-merged. Attached PRs that are not Bosun-created are skipped by default unless explicitly trusted in config.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    mergeMethod:        "merge",                    // merge | squash | rebase
    labelNeedsFix:      "bosun-needs-fix",           // applied to CI failures and conflicts
    labelNeedsReview:   "bosun-needs-human-review",  // applied when review agent flags a suspicious diff
    // auto: active workspace repos from bosun.config.json (fallback current repo)
    // all/current/<owner/repo>/comma,list also supported.
    repoScope:          "auto",
    maxPrs:             25,
    intervalMs:         1_800_000,                  // 30 min — safety-net fallback; event-driven templates handle real-time responses
    // Merge-safety thresholds checked by the review agent:
    // If net deletions > additions × ratio AND deletions > minDestructiveDeletions → HOLD
    suspiciousDeletionRatio: 3,    // e.g. deletes 3× more lines than it adds
    minDestructiveDeletions: 500,  // absolute floor — small PRs are fine even if net negative
    autoApplySuggestions:   true,  // auto-commit review suggestions before merge
    trustedAuthors:         "",
    allowTrustedFixes:      false,
    allowTrustedMerges:     false,
    // Per-PR parallel fix dispatch (replaces single mega-agent):
    maxConcurrentFixes:     3,     // how many PR fix agents run in parallel
    prFixTtlMinutes:        120,   // minutes before a PR claim expires (allows re-dispatch)

  },
  nodes: [
    node("trigger", "trigger.schedule", "Poll Every 90s", {
      intervalMs: "{{intervalMs}}",
    }, { x: 400, y: 50 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: One gh pr list per target repo, then classify+label in-memory.
    // This avoids duplicate fetches and keeps per-cycle gh traffic bounded.
    // ─────────────────────────────────────────────────────────────────────────
    node("fetch-and-classify", "action.run_command", "Fetch, Classify & Label PRs", {
      // Fetches all open bosun-attached PRs with every field needed for
      // classification. Runs one list call per target repo (auto-discovered
      // from bosun.config.json workspaces by default), then:
      //   • Classifies each PR into: ready | conflict | security_failure | ci_failure | shared_ci_failure | pending | draft
      //   • Labels conflict/security_failure/ci_failure PRs with bosun-needs-fix (skips if already present)
      //   • Outputs a JSON summary used by all downstream nodes/agents
      // Total gh API calls this node makes: R list calls + N edits
      // (R = target repos, N = newly-broken PRs needing fix label).
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const {execFileSync}=require('child_process');",
        "const LABEL_FIX='{{labelNeedsFix}}';",
        "const MAX_PRS=Math.max(1,Number('{{maxPrs}}')||25);",
        "const REPO_SCOPE=String('{{repoScope}}'||'auto').trim();",
        "const FIELDS='number,title,body,author,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,labels,url';",
        "const FAIL_STATES=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const PEND_STATES=new Set(['PENDING','IN_PROGRESS','QUEUED','WAITING','REQUESTED','EXPECTED']);",
        "const CONFLICT_MERGEABLES=new Set(['CONFLICTING','DIRTY']);",
        "const BEHIND_MERGEABLES=new Set(['BEHIND']);",
        "const SECURITY_CHECK_RE=/(^|[^a-z])(codeql|code scanning|security|sarif|codacy)([^a-z]|$)/i;",
        "const BOSUN_CREATED_LABEL='bosun-pr-bosun-created';",
        "function readCheckName(check){return String(check?.name||check?.context||check?.workflowName||check?.displayTitle||'').trim();}",
        "function isFailedCheck(check){return FAIL_STATES.has(check?.conclusion||check?.state||'');}",
        "function isSecurityCheckName(name){return SECURITY_CHECK_RE.test(String(name||''));}",
        GH_CLI_RESILIENCE_SNIPPET,
        "function normalizeList(value){if(Array.isArray(value)) return value.map((entry)=>String(entry||'').trim().toLowerCase()).filter(Boolean); return String(value||'').split(',').map((entry)=>entry.trim().toLowerCase()).filter(Boolean);}",
        "function parseBool(value,fallback){if(value===undefined||value===null||value==='') return fallback; const raw=String(value).trim().toLowerCase(); if(['1','true','yes','on'].includes(raw)) return true; if(['0','false','no','off'].includes(raw)) return false; return fallback;}",
        "function normalizeCheckKey(name){return String(name||'').trim().toLowerCase().replace(/\\s+/g,' ');}",
        "function matchesCheckPattern(name,pattern){const text=String(name||'').trim().toLowerCase();const token=String(pattern||'').trim().toLowerCase();if(!text||!token)return false;if(token==='*')return true;if(!token.includes('*'))return text.includes(token);const parts=token.split('*').filter(Boolean);if(parts.length===0)return true;let cursor=0;for(const part of parts){const idx=text.indexOf(part,cursor);if(idx===-1)return false;cursor=idx+part.length;}if(!token.startsWith('*')&&!text.startsWith(parts[0]||''))return false;if(!token.endsWith('*')&&!text.endsWith(parts[parts.length-1]||''))return false;return true;}",
        "function matchesAnyPattern(name,patterns){return (Array.isArray(patterns)?patterns:[]).some((pattern)=>matchesCheckPattern(name,pattern));}",
        "function readCheckState(check){return String(check?.conclusion||check?.state||check?.status||check?.bucket||'').trim().toUpperCase();}",
        "function isPassingCheckState(state,treatNeutralAsPass){if(!state)return true;if(['SUCCESS','PASS','PASSED','COMPLETED'].includes(state))return true;if(treatNeutralAsPass&&['NEUTRAL','SKIPPED'].includes(state))return true;return !FAIL_STATES.has(state)&&!PEND_STATES.has(state);}",
        "function evaluateCheckGates(checks,policy){const normalized=(Array.isArray(checks)?checks:[]).map((check)=>({raw:check,name:readCheckName(check),state:readCheckState(check)})).filter((check)=>check.name);const considered=normalized.filter((check)=>!matchesAnyPattern(check.name,policy.ignorePatterns));let required=considered;if(policy.mode==='required-only'){required=considered.filter((check)=>matchesAnyPattern(check.name,policy.requiredPatterns));}if((Array.isArray(policy.optionalPatterns)?policy.optionalPatterns:[]).length>0){required=required.filter((check)=>!matchesAnyPattern(check.name,policy.optionalPatterns));}const missingRequired=policy.requireAnyRequiredCheck&&required.length===0;const failedRequiredChecks=required.filter((check)=>FAIL_STATES.has(check.state));const pendingRequiredChecks=required.filter((check)=>PEND_STATES.has(check.state));const hasRequiredFailure=failedRequiredChecks.length>0;const hasBlockingPending=policy.treatPendingRequiredAsBlocking&&pendingRequiredChecks.length>0;const isReady=!missingRequired&&!hasRequiredFailure&&!hasBlockingPending&&required.every((check)=>isPassingCheckState(check.state,policy.treatNeutralAsPass));return {consideredCount:considered.length,requiredCount:required.length,failedRequiredChecks:failedRequiredChecks.map((check)=>check.raw),pendingRequiredChecks:pendingRequiredChecks.map((check)=>check.raw),hasRequiredFailure,hasBlockingPending,blocksForMissingRequired:missingRequired,isReady,shouldKickCi:considered.length===0};}",
        "function buildFailureFingerprint(names){const normalized=[...new Set((Array.isArray(names)?names:[]).map(normalizeCheckKey).filter(Boolean))].sort();return normalized.join('|');}",
        "function readLabelNames(pr){return Array.isArray(pr?.labels)?pr.labels.map((entry)=>typeof entry==='string'?entry:entry?.name).filter(Boolean):[];}",
        "function isBosunCreated(pr){return readLabelNames(pr).includes(BOSUN_CREATED_LABEL);}",
        "function readAuthorLogin(pr){return String(pr?.author?.login||pr?.author?.name||'').trim().toLowerCase();}",
        "function configPath(){",
        "  const home=String(process.env.BOSUN_HOME||process.env.BOSUN_PROJECT_DIR||'').trim();",
        "  return home?path.join(home,'bosun.config.json'):path.join(process.cwd(),'bosun.config.json');",
        "}",
        "function readBosunConfig(){ try { return JSON.parse(fs.readFileSync(configPath(),'utf8')); } catch { return {}; } }",
        "function collectReposFromConfig(){",
        "  const repos=[];",
        "  try{",
        "    const cfg=readBosunConfig();",
        "    const workspaces=Array.isArray(cfg?.workspaces)?cfg.workspaces:[];",
        "    if(workspaces.length>0){",
        "      const active=String(cfg?.activeWorkspace||'').trim().toLowerCase();",
        "      const activeWs=active?workspaces.find(w=>String(w?.id||'').trim().toLowerCase()===active):null;",
        "      const wsList=activeWs?[activeWs]:workspaces;",
        "      for(const ws of wsList){",
        "        for(const repo of (Array.isArray(ws?.repos)?ws.repos:[])){",
        "          const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();",
        "          if(slug) repos.push(slug);",
        "        }",
        "      }",
        "    }",
        "    if(repos.length===0){",
        "      for(const repo of (Array.isArray(cfg?.repos)?cfg.repos:[])){",
        "        const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();",
        "        if(slug) repos.push(slug);",
        "      }",
        "    }",
        "  }catch{}",
        "  return repos;",
        "}",
        "function resolveRepoTargets(){",
        "  if(REPO_SCOPE&&REPO_SCOPE!=='auto'&&REPO_SCOPE!=='all'&&REPO_SCOPE!=='current'){",
        "    return [...new Set(REPO_SCOPE.split(',').map(v=>v.trim()).filter(Boolean))];",
        "  }",
        "  if(REPO_SCOPE==='current') return [''];",
        "  const fromConfig=collectReposFromConfig();",
        "  if(fromConfig.length>0) return [...new Set(fromConfig)];",
        "  const envRepo=String(process.env.GITHUB_REPOSITORY||'').trim();",
        "  if(envRepo) return [envRepo];",
        "  return [''];",
        "}",
        "const BOSUN_CONFIG=readBosunConfig();",
        "const PR_AUTOMATION=(BOSUN_CONFIG&&typeof BOSUN_CONFIG.prAutomation==='object')?BOSUN_CONFIG.prAutomation:{};",
        "const ATTACH_MODE=((String(PR_AUTOMATION?.attachMode||'all').trim().toLowerCase())||'all');",
        "const TRUSTED_AUTHORS=new Set([...normalizeList(PR_AUTOMATION?.trustedAuthors),...normalizeList('{{trustedAuthors}}')]);",
        "const ALLOW_TRUSTED_FIXES=parseBool(PR_AUTOMATION?.allowTrustedFixes ?? '{{allowTrustedFixes}}', false);",
        "const ALLOW_TRUSTED_MERGES=parseBool(PR_AUTOMATION?.allowTrustedMerges ?? '{{allowTrustedMerges}}', false);",
        "const CHECK_GATES=(BOSUN_CONFIG&&typeof BOSUN_CONFIG.gates==='object'&&BOSUN_CONFIG.gates&&typeof BOSUN_CONFIG.gates.checks==='object')?BOSUN_CONFIG.gates.checks:{};",
        "const CHECK_MODE=((String(CHECK_GATES?.mode||'all').trim().toLowerCase())||'all');",
        "const REQUIRED_CHECK_PATTERNS=normalizeList(CHECK_GATES?.requiredPatterns);",
        "const OPTIONAL_CHECK_PATTERNS=normalizeList(CHECK_GATES?.optionalPatterns);",
        "const IGNORE_CHECK_PATTERNS=normalizeList(CHECK_GATES?.ignorePatterns);",
        "const REQUIRE_ANY_REQUIRED_CHECK=parseBool(CHECK_GATES?.requireAnyRequiredCheck, true);",
        "const TREAT_PENDING_REQUIRED_AS_BLOCKING=parseBool(CHECK_GATES?.treatPendingRequiredAsBlocking, true);",
        "const TREAT_NEUTRAL_AS_PASS=parseBool(CHECK_GATES?.treatNeutralAsPass, false);",
        "const defaultBranchFailureCache=new Map();",
        "function collectDefaultBranchFailureNames(repo,baseBranch){const cacheKey=[repo,baseBranch].join('::');if(defaultBranchFailureCache.has(cacheKey))return defaultBranchFailureCache.get(cacheKey);const failedNames=new Set();try{const runs=safeGhJson(['run','list','--repo',repo,'--branch',baseBranch,'--json','databaseId,workflowName,displayTitle,conclusion,status','--limit','6'],[]);for(const run of (Array.isArray(runs)?runs:[])){const conclusion=String(run?.conclusion||'').trim().toUpperCase();if(!FAIL_STATES.has(conclusion))continue;const runId=Number(run?.databaseId||0)||0;if(runId>0){const view=safeGhJson(['run','view',String(runId),'--repo',repo,'--json','jobs'],{});const jobs=Array.isArray(view?.jobs)?view.jobs:[];for(const job of jobs){const jobState=String(job?.conclusion||job?.status||'').trim().toUpperCase();if(FAIL_STATES.has(jobState)){const normalized=normalizeCheckKey(job?.name);if(normalized)failedNames.add(normalized);}}}const workflowName=normalizeCheckKey(run?.workflowName||run?.displayTitle);if(workflowName)failedNames.add(workflowName);}}catch{}const resolved=[...failedNames];defaultBranchFailureCache.set(cacheKey,resolved);return resolved;}",
        "function parseRepoFromUrl(url){",
        "  const raw=String(url||'');",
        "  const marker='github.com/';",
        "  const idx=raw.toLowerCase().indexOf(marker);",
        "  if(idx<0) return '';",
        "  const tail=raw.slice(idx+marker.length).split('/');",
        "  if(tail.length<2) return '';",
        "  const owner=String(tail[0]||'').trim();",
        "  const repo=String(tail[1]||'').trim();",
        "  return owner&&repo?(owner+'/'+repo):'';",
        "}",
        "const repoTargets=resolveRepoTargets();",
        "const prs=[];",
        "const repoErrors=[];",
        "for(const target of repoTargets){",
        "  const repo=String(target||'').trim();",
        "  const args=['pr','list','--state','open','--json',FIELDS,'--limit',String(MAX_PRS)];",
        "  if(repo) args.push('--repo',repo);",
        "  try{",
        "    const list=ghJson(args);",
        "    for(const pr of (Array.isArray(list)?list:[])){",
        "      const prRepo=repo||parseRepoFromUrl(pr?.url)||String(process.env.GITHUB_REPOSITORY||'').trim();",
        "      prs.push({...pr,__repo:prRepo});",
        "    }",
        "  }catch(e){",
        "    repoErrors.push({repo:repo||'current',error:String(e?.message||e)});",
        "  }",
        "}",
        "const taskCli=path.join(process.cwd(),'task','task-cli.mjs');",
        "const taskRunner=fs.existsSync(taskCli)?'direct':'cli';",
        "const taskMaxBuffer=1024*1024*8;",
        "function parseJson(raw,fallback){try{return JSON.parse(raw||'')}catch{return fallback;}}",
        "function runTask(args){const cmdArgs=taskRunner==='cli'?['cli.mjs','task',...args,'--config-dir','.bosun','--repo-root','.']:[taskCli,...args];return execFileSync('node',cmdArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:taskMaxBuffer}).trim();}",
        "let taskListCache=null;",
        "function loadTaskList(){if(taskListCache)return taskListCache;try{const raw=runTask(['list','--json']);const tasks=parseJson(raw,[]);taskListCache=Array.isArray(tasks)?tasks:[];}catch{taskListCache=[];}return taskListCache;}",
        "function normalizeTaskValue(value){return String(value||'').trim().toLowerCase();}",
        "function resolveTaskIdForPr(item){const prNumber=Number(item?.n||0)||0;const prUrl=normalizeTaskValue(item?.url);const branch=normalizeTaskValue(item?.branch);const matches=loadTaskList().filter((task)=>{if(!task||typeof task!=='object')return false;const taskPrNumber=Number(task?.prNumber||task?.pr_number||0)||0;if(prNumber>0&&taskPrNumber===prNumber)return true;const taskPrUrl=normalizeTaskValue(task?.prUrl||task?.pr_url);if(prUrl&&taskPrUrl===prUrl)return true;const taskBranch=normalizeTaskValue(task?.branchName||task?.branch||task?.meta?.branchName||task?.meta?.branch);return Boolean(branch&&taskBranch===branch);});if(matches.length===0)return null;const inReview=matches.find((task)=>normalizeTaskValue(task?.status)==='inreview');return String((inReview||matches[0])?.id||'').trim()||null;}",
        "function getTaskSnapshot(id){if(!id)return null;try{return parseJson(runTask(['get',id,'--json']),null);}catch{return null;}}",
        "function updateTaskReviewSignal(item){const taskId=resolveTaskIdForPr(item);if(!taskId)return false;const snapshot=getTaskSnapshot(taskId)||{};const existingMeta=snapshot?.meta&&typeof snapshot.meta==='object'?snapshot.meta:{};const existingReviewHealth=existingMeta.reviewHealth&&typeof existingMeta.reviewHealth==='object'?existingMeta.reviewHealth:{};const nextReviewHealth={...existingReviewHealth,status:String(item?.reviewStatus||'unknown'),failureScope:String(item?.failureScope||'none'),sharedIncidentId:item?.sharedIncidentId||null,failureFingerprint:item?.failureFingerprint||null,failingWorkflow:item?.failingWorkflow||null,failingJobs:Array.isArray(item?.failedCheckNames)?item.failedCheckNames:[],baseBranch:String(item?.base||snapshot?.baseBranch||'').trim()||null,repo:String(item?.repo||'').trim()||null,updatedAt:new Date().toISOString(),source:'pr-watchdog'};const patch={meta:{...existingMeta,reviewHealth:nextReviewHealth}};try{runTask(['update',taskId,JSON.stringify(patch)]);return true;}catch{return false;}}",
        "const sharedFailureFingerprints=new Map();",
        "for(const pr of prs){const labels=(pr.labels||[]).map(l=>typeof l==='string'?l:l?.name).filter(Boolean);const bosunCreated=isBosunCreated(pr);const trustedAuthor=TRUSTED_AUTHORS.has(readAuthorLogin(pr));const attachEligible=bosunCreated||ATTACH_MODE==='all'||(ATTACH_MODE==='trusted-only'&&trustedAuthor);const checks=pr.statusCheckRollup||[];const gateVerdict=evaluateCheckGates(checks,{mode:CHECK_MODE,requiredPatterns:REQUIRED_CHECK_PATTERNS,optionalPatterns:OPTIONAL_CHECK_PATTERNS,ignorePatterns:IGNORE_CHECK_PATTERNS,requireAnyRequiredCheck:REQUIRE_ANY_REQUIRED_CHECK,treatPendingRequiredAsBlocking:TREAT_PENDING_REQUIRED_AS_BLOCKING,treatNeutralAsPass:TREAT_NEUTRAL_AS_PASS});const failedCheckNames=gateVerdict.failedRequiredChecks.map(readCheckName).filter(Boolean);const hasSecurityFail=failedCheckNames.some(isSecurityCheckName);const isConflict=CONFLICT_MERGEABLES.has(String(pr.mergeable||'').toUpperCase());const isDraft=pr.isDraft===true;const repo=String(pr.__repo||'').trim();const base=String(pr.baseRefName||'').trim()||'main';if(isDraft||!attachEligible||!gateVerdict.hasRequiredFailure||hasSecurityFail||isConflict)continue;const fingerprint=buildFailureFingerprint(failedCheckNames);if(!fingerprint)continue;const sharedKey=[repo,base,fingerprint].join('::');sharedFailureFingerprints.set(sharedKey,(sharedFailureFingerprints.get(sharedKey)||0)+1);}",
        "const readyCandidates=[],conflicts=[],securityFailures=[],ciFailures=[],sharedFailures=[],pending=[],drafted=[],behindBranches=[],skippedUntrusted=[];",
        "let newlyLabeled=0,staleLabelCleared=0,ciKicked=0,taskReviewSignalsUpdated=0;",
        "for(const pr of prs){",
        "  const labels=(pr.labels||[]).map(l=>typeof l==='string'?l:l?.name).filter(Boolean);",
        "  const bosunCreated=isBosunCreated(pr);",
        "  const trustedAuthor=TRUSTED_AUTHORS.has(readAuthorLogin(pr));",
        "  const attachEligible=bosunCreated || ATTACH_MODE==='all' || (ATTACH_MODE==='trusted-only' && trustedAuthor);",
        "  const canFix=bosunCreated || (attachEligible && ALLOW_TRUSTED_FIXES && trustedAuthor);",
        "  const canMerge=bosunCreated || (attachEligible && ALLOW_TRUSTED_MERGES && trustedAuthor);",
        "  const hasFixLabel=labels.includes(LABEL_FIX);",
        "  const checks=pr.statusCheckRollup||[];",
        "  const gateVerdict=evaluateCheckGates(checks,{mode:CHECK_MODE,requiredPatterns:REQUIRED_CHECK_PATTERNS,optionalPatterns:OPTIONAL_CHECK_PATTERNS,ignorePatterns:IGNORE_CHECK_PATTERNS,requireAnyRequiredCheck:REQUIRE_ANY_REQUIRED_CHECK,treatPendingRequiredAsBlocking:TREAT_PENDING_REQUIRED_AS_BLOCKING,treatNeutralAsPass:TREAT_NEUTRAL_AS_PASS});",
        "  const failedChecks=gateVerdict.failedRequiredChecks;",
        "  const failedCheckNames=failedChecks.map(readCheckName).filter(Boolean);",
        "  const securityCheckNames=failedCheckNames.filter(isSecurityCheckName);",
        "  const hasFail=gateVerdict.hasRequiredFailure;",
        "  const hasSecurityFail=securityCheckNames.length>0;",
        "  const hasPend=gateVerdict.hasBlockingPending;",
        "  const isConflict=CONFLICT_MERGEABLES.has(String(pr.mergeable||'').toUpperCase());",
        "  const isBehind=BEHIND_MERGEABLES.has(String(pr.mergeable||'').toUpperCase());",
        "  const isDraft=pr.isDraft===true;",
        "  const repo=String(pr.__repo||'').trim();",
        "  const base=String(pr.baseRefName||'').trim()||'main';",
        "  const failureFingerprint=buildFailureFingerprint(failedCheckNames);",
        "  const sharedFailureKey=[repo,base,failureFingerprint].join('::');",
        "  const repeatedFailureCount=Number(sharedFailureFingerprints.get(sharedFailureKey)||0);",
        "  const defaultBranchFailureNames=repo&&base?collectDefaultBranchFailureNames(repo,base):[];",
        "  const defaultBranchFailureSet=new Set((Array.isArray(defaultBranchFailureNames)?defaultBranchFailureNames:[]).map(normalizeCheckKey).filter(Boolean));",
        "  const allFailuresOnDefaultBranch=failedCheckNames.length>0&&failedCheckNames.every((name)=>defaultBranchFailureSet.has(normalizeCheckKey(name)));",
        "  const isSharedFailure=hasFail&&!hasSecurityFail&&!isConflict&&allFailuresOnDefaultBranch;",
        "  const sharedIncidentId=isSharedFailure&&failureFingerprint?[repo,base,failureFingerprint].join(':'):null;",
        "  if(isDraft){drafted.push({n:pr.number,repo});continue;}",
        "  if(!bosunCreated && !attachEligible){skippedUntrusted.push({n:pr.number,repo,reason:'attach_policy_excluded'});continue;}",
        "  if(!bosunCreated && !trustedAuthor){skippedUntrusted.push({n:pr.number,repo,reason:'public_observation_only'});continue;}",
        "  if(isBehind&&!isConflict){",
        "    if(canFix) behindBranches.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url});",
        "  }",
        "  if(isConflict){",
        "    if(!canFix){skippedUntrusted.push({n:pr.number,repo,reason:'fix_not_allowed'});continue;}",
        "    conflicts.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url,mergeable:String(pr.mergeable||'').toUpperCase()});",
        "    if(updateTaskReviewSignal({n:pr.number,repo,branch:pr.headRefName,base,url:pr.url,reviewStatus:'conflict',failureScope:'pr_local',failedCheckNames:[],failureFingerprint:null,failingWorkflow:null,sharedIncidentId:null}))taskReviewSignalsUpdated++;",
        "    if(!hasFixLabel){",
        "      try{const editArgs=['pr','edit',String(pr.number),'--add-label',LABEL_FIX];if(repo)editArgs.push('--repo',repo);execFileSync('gh',editArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});newlyLabeled++;}",
        "      catch(e){process.stderr.write('label err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\\\n');}",
        "    }",
        "  } else if(hasSecurityFail){",
        "    if(!canFix){skippedUntrusted.push({n:pr.number,repo,reason:'security_fix_not_allowed'});continue;}",
        "    securityFailures.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url,title:pr.title,failedCheckNames,securityCheckNames});",
        "    if(updateTaskReviewSignal({n:pr.number,repo,branch:pr.headRefName,base,url:pr.url,reviewStatus:'security_failure',failureScope:'pr_local',failedCheckNames,failureFingerprint,failingWorkflow:securityCheckNames[0]||failedCheckNames[0]||null,sharedIncidentId:null}))taskReviewSignalsUpdated++;",
        "    if(!hasFixLabel){",
        "      try{const editArgs=['pr','edit',String(pr.number),'--add-label',LABEL_FIX];if(repo)editArgs.push('--repo',repo);execFileSync('gh',editArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});newlyLabeled++;}",
        "      catch(e){process.stderr.write('label err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\n');}",
        "    }",
        "    const nonSecurityFailedChecks=failedCheckNames.filter(n=>!isSecurityCheckName(n));",
        "    if(nonSecurityFailedChecks.length>0){",
        "      ciFailures.push({n:pr.number,repo,branch:pr.headRefName,url:pr.url,failedCheckNames:nonSecurityFailedChecks,alsoInSecurityFailures:true});",
        "    }",
        "  } else if(hasFail){",
        "    if(isSharedFailure){",
        "      sharedFailures.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url,title:pr.title,failedCheckNames,failureFingerprint,sharedIncidentId,defaultBranchFailureNames,repeatedFailureCount});",
        "      if(updateTaskReviewSignal({n:pr.number,repo,branch:pr.headRefName,base,url:pr.url,reviewStatus:'shared_ci_failure',failureScope:'shared',failedCheckNames,failureFingerprint,failingWorkflow:failedCheckNames[0]||null,sharedIncidentId}))taskReviewSignalsUpdated++;",
        "      if(hasFixLabel){",
        "        try{const rmArgs=['pr','edit',String(pr.number),'--remove-label',LABEL_FIX];if(repo)rmArgs.push('--repo',repo);execFileSync('gh',rmArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});staleLabelCleared++;}",
        "        catch(e){process.stderr.write('shared-label-rm err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\n');}",
        "      }",
        "      continue;",
        "    }",
        "    if(!canFix){skippedUntrusted.push({n:pr.number,repo,reason:'ci_fix_not_allowed'});continue;}",
        "    ciFailures.push({n:pr.number,repo,branch:pr.headRefName,url:pr.url,failedCheckNames});",
        "    if(updateTaskReviewSignal({n:pr.number,repo,branch:pr.headRefName,base,url:pr.url,reviewStatus:'ci_failure',failureScope:'pr_local',failedCheckNames,failureFingerprint,failingWorkflow:failedCheckNames[0]||null,sharedIncidentId:null}))taskReviewSignalsUpdated++;",
        "    if(!hasFixLabel){",
        "      try{const editArgs=['pr','edit',String(pr.number),'--add-label',LABEL_FIX];if(repo)editArgs.push('--repo',repo);execFileSync('gh',editArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});newlyLabeled++;}",
        "      catch(e){process.stderr.write('label err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\\\n');}",
        "    }",
        "  } else {",
        "    if(updateTaskReviewSignal({n:pr.number,repo,branch:pr.headRefName,base,url:pr.url,reviewStatus:hasPend?'pending':gateVerdict.isReady?'ready':'idle',failureScope:'none',failedCheckNames:[],failureFingerprint:null,failingWorkflow:null,sharedIncidentId:null}))taskReviewSignalsUpdated++;",
        "    if(hasFixLabel&&!hasPend&&!gateVerdict.blocksForMissingRequired){",
        "      try{",
        "        const rmArgs=['pr','edit',String(pr.number),'--remove-label',LABEL_FIX];",
        "        if(repo)rmArgs.push('--repo',repo);",
        "        execFileSync('gh',rmArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe']});",
        "        staleLabelCleared++;",
        "      }catch(e){process.stderr.write('stale-label-rm err '+(repo?repo+' ':'')+'#'+pr.number+': '+(e?.message||e)+'\\\\n');}",
        "    } else if(gateVerdict.isReady&&!hasFixLabel){",
        "      if(hasPend) pending.push({n:pr.number,repo});",
        "      if(canMerge){ readyCandidates.push({n:pr.number,repo,branch:pr.headRefName,base:pr.baseRefName,url:pr.url,title:pr.title,pendingChecks:hasPend}); } else { skippedUntrusted.push({n:pr.number,repo,reason:'merge_not_allowed'}); }",
        "    }",
        "    if(gateVerdict.shouldKickCi&&repo&&pr.headRefName&&!isDraft){",
        "      try{execFileSync('gh',['workflow','run','ci.yaml','--repo',repo,'--ref',pr.headRefName],{encoding:'utf8',stdio:['pipe','pipe','pipe']});ciKicked++;}",
        "      catch{}",
        "    }",
        "  }",
        "}",
        "console.log(JSON.stringify({",
        "  total:prs.length,",
        "  reposScanned:repoTargets.length,",
        "  repoErrors,",
        "  readyCandidates,",
        "  conflicts,",
        "  behindBranches,",
        "  securityFailures,",
        "  ciFailures,",
        "  sharedFailures,",
        "  pending:pending.length,",
        "  drafted:drafted.length,",
        "  skippedUntrusted,",
        "  newlyLabeled,",
        "  staleLabelCleared,",
        "  ciKicked,",
        "  fixNeeded:conflicts.length+securityFailures.length+ciFailures.length,",
        "  sharedIncidentCount:sharedFailures.length,",
        "  taskReviewSignalsUpdated,",
        "  trustPolicy:{trustedAuthors:[...TRUSTED_AUTHORS],allowTrustedFixes:ALLOW_TRUSTED_FIXES,allowTrustedMerges:ALLOW_TRUSTED_MERGES}",
        "}));",
      ].join(" ")],
      continueOnError: false,
      failOnError: true,
    }, { x: 400, y: 200 }),

    node("has-prs", "condition.expression", "Any Bosun PRs?", {
      expression:
        "(()=>{try{" +
        "const r=$ctx.getNodeOutput('fetch-and-classify');" +
        "if(!r||r.success===false)return false;" +
        "const o=r.output;" +
        "return (JSON.parse(o||'{}').total||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 400, y: 370 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1b: Fast-path — update behind branches (no conflicts, just out-of-date)
    // ─────────────────────────────────────────────────────────────────────────
    node("has-behind", "condition.expression", "Behind Branches?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').behindBranches||[]).length>0;" +
        "}catch(e){return false;}})()",
    }, { x: 400, y: 450 }),

    node("update-behind-branches", "action.run_command", "Update Behind Branches", {
      command: [
        "node -e \"",
        "const {execFileSync}=require('child_process');",
        "const raw=String(process.env.BOSUN_FETCH_AND_CLASSIFY||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const behind=Array.isArray(payload.behindBranches)?payload.behindBranches:[];",
        "let updated=0,failed=0;",
        "for(const pr of behind){",
        "  const repo=String(pr.repo||'').trim();",
        "  if(!repo){console.log('skip PR '+pr.n+' — no repo slug');continue;}",
        "  try{",
        "    execFileSync('gh',['api','repos/'+repo+'/pulls/'+pr.n+'/update-branch','--method','PUT'],{encoding:'utf8',stdio:['pipe','pipe','pipe']});",
        "    updated++;",
        "    console.log('Updated PR #'+pr.n+' ('+repo+')');",
        "  }catch(e){",
        "    failed++;",
        "    console.log('Failed to update PR #'+pr.n+' ('+repo+'): '+String(e.message||e).slice(0,200));",
        "  }",
        "}",
        "console.log(JSON.stringify({updated,failed,total:behind.length}));",
        "\"",
      ].join(" "),
      continueOnError: true,
      failOnError: false,
      timeout: 120000,
      env: {
        BOSUN_FETCH_AND_CLASSIFY:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    }, { x: 600, y: 450 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2a: Fix path — route security failures separately, then dispatch
    // the generic agent path for conflicts + non-security CI failures.
    // ─────────────────────────────────────────────────────────────────────────
    node("fix-needed", "condition.expression", "Fix Needed?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').fixNeeded||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 200, y: 530 }),

    node("security-fix-needed", "condition.expression", "Security Fix Needed?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').securityFailures||[]).length>0;" +
        "}catch(e){return false;}})()",
    }, { x: 120, y: 640 }),

    node("programmatic-security-fix", "action.run_command", "Collect Security Alerts", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const raw=String(process.env.BOSUN_FETCH_AND_CLASSIFY||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const securityFailures=Array.isArray(payload.securityFailures)?payload.securityFailures:[];",
        "const needsAgent=[];",
        "let alertsFetched=0;",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function safeGhJson(args,fallback){try{const out=gh(args);return out?JSON.parse(out):fallback;}catch{return fallback;}}",
        "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
        "function compactUser(user){const login=String(user?.login||user?.name||'').trim();return login?{login,url:String(user?.url||user?.html_url||'').trim()||null}:null;}",
        "function compactCheck(check){const name=String(check?.name||check?.context||check?.workflowName||'').trim();const state=String(check?.state||check?.conclusion||'').toUpperCase();const bucket=String(check?.bucket||'').toUpperCase();if(!name&&!state&&!bucket)return null;return {name:name||null,state:state||null,bucket:bucket||null,workflow:String(check?.workflowName||'').trim()||null};}",
        "function compactIssueComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactReview(review){return {id:Number(review?.id||0)||null,author:compactUser(review?.user||review?.author),state:String(review?.state||'').trim()||null,submittedAt:String(review?.submitted_at||review?.submittedAt||'').trim()||null,body:truncateText(review?.body,1200)};}",
        "function compactReviewComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),path:String(comment?.path||'').trim()||null,line:Number(comment?.line||0)||Number(comment?.original_line||0)||null,side:String(comment?.side||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactFile(file){const path=String(file?.filename||file?.path||'').trim();return path?{path,status:String(file?.status||'').trim()||null,additions:Number(file?.additions||0)||0,deletions:Number(file?.deletions||0)||0,changes:Number(file?.changes||0)||0}:null;}",
        "function collectPrDigest(repo,number,fallback){const pr=safeGhJson(['pr','view',String(number),'--repo',repo,'--json','number,title,body,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,author,labels,reviewDecision'],{});const issueComments=safeGhJson(['api','repos/'+repo+'/issues/'+number+'/comments?per_page=100'],[]).map(compactIssueComment).slice(0,40);const reviews=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/reviews?per_page=100'],[]).map(compactReview).slice(0,40);const reviewComments=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/comments?per_page=100'],[]).map(compactReviewComment).slice(0,60);const files=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/files?per_page=100'],[]).map(compactFile).filter(Boolean).slice(0,80);const requested=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/requested_reviewers'],{});const requestedReviewers=[...(Array.isArray(requested?.users)?requested.users:[]).map(compactUser),...(Array.isArray(requested?.teams)?requested.teams:[]).map((team)=>{const slug=String(team?.slug||team?.name||'').trim();return slug?{team:slug,url:String(team?.html_url||team?.url||'').trim()||null}:null;})].filter(Boolean);const checks=(Array.isArray(pr.statusCheckRollup)?pr.statusCheckRollup:[]).map(compactCheck).filter(Boolean);const labels=(Array.isArray(pr.labels)?pr.labels:[]).map((label)=>String(label?.name||label||'').trim()).filter(Boolean);const failingChecks=checks.filter((check)=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(check.state)||check.bucket==='FAIL');const pendingChecks=checks.filter((check)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(check.state));const digestSummary=['PR #'+String(pr?.number||number)+' '+String(pr?.title||fallback?.title||''),'repo='+repo+' branch='+(String(pr?.headRefName||fallback?.branch||'').trim()||'unknown'),'checks='+checks.length+' fail='+failingChecks.length+' pending='+pendingChecks.length,'comments='+issueComments.length+' reviews='+reviews.length+' reviewComments='+reviewComments.length+' files='+files.length,labels.length?'labels='+labels.join(', '):''].filter(Boolean).join('\\n');return {core:{number:Number(pr?.number||number)||number,title:String(pr?.title||fallback?.title||''),url:String(pr?.url||fallback?.url||'').trim()||null,body:truncateText(pr?.body,4000),branch:String(pr?.headRefName||fallback?.branch||'').trim()||null,baseBranch:String(pr?.baseRefName||fallback?.base||'').trim()||null,isDraft:pr?.isDraft===true,mergeable:String(pr?.mergeable||'').trim()||null,author:compactUser(pr?.author),reviewDecision:String(pr?.reviewDecision||'').trim()||null},labels,requestedReviewers,checks,ciSummary:{total:checks.length,failing:failingChecks.length,pending:pendingChecks.length,passing:Math.max(0,checks.length-failingChecks.length-pendingChecks.length)},issueComments,reviews,reviewComments,files,digestSummary};}",
        "function compactAlert(alert){",
        "  const instance=alert?.most_recent_instance||{};",
        "  const location=instance?.location||{};",
        "  const rule=alert?.rule||{};",
        "  const tool=alert?.tool||{};",
        "  return {",
        "    number: alert?.number ?? null,",
        "    state: String(alert?.state||''),",
        "    ruleId: String(rule?.id||alert?.rule_id||''),",
        "    ruleName: String(rule?.name||alert?.rule_name||''),",
        "    severity: String(rule?.severity||alert?.severity||''),",
        "    securitySeverity: String(rule?.security_severity_level||alert?.security_severity_level||''),",
        "    tool: String(tool?.name||alert?.tool_name||''),",
        "    path: String(location?.path||''),",
        "    startLine: Number(location?.start_line||0)||null,",
        "    url: String(alert?.html_url||''),",
        "  };",
        "}",
        "for(const item of securityFailures){",
        "  const repo=String(item?.repo||'').trim();",
        "  const branch=String(item?.branch||'').trim();",
        "  const n=String(item?.n||'').trim();",
        "  const securityCheckNames=Array.isArray(item?.securityCheckNames)?item.securityCheckNames:[];",
        "  const prDigest=repo&&n?collectPrDigest(repo,n,{branch,base:String(item?.base||'').trim(),title:String(item?.title||''),url:String(item?.url||'')}):null;",
        "  if(!repo||!branch){needsAgent.push({repo,number:n,branch,reason:'missing_repo_or_branch',securityCheckNames,alerts:[],prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  let alerts=[];",
        "  let fetchError='';",
        "  try{",
        "    const alertsRaw=gh(['api','--method','GET','repos/'+repo+'/code-scanning/alerts','--raw-field','state=open','--raw-field','per_page=20','--raw-field','ref=refs/heads/'+branch]);",
        "    const parsed=(()=>{try{return JSON.parse(alertsRaw||'[]')}catch{return []}})();",
        "    alerts=(Array.isArray(parsed)?parsed:[]).map(compactAlert).filter(a=>a.ruleId||a.ruleName||a.path).slice(0,10);",
        "    if(alerts.length>0) alertsFetched++;",
        "  }catch(e){fetchError=String(e?.message||e);}",
        "  needsAgent.push({repo,number:n,branch,base:String(item?.base||'').trim(),url:String(item?.url||''),title:String(item?.title||''),reason:'security_code_scanning_failure',securityCheckNames,failedCheckNames:Array.isArray(item?.failedCheckNames)?item.failedCheckNames:[],alerts,fetchError,prDigest,digestSummary:String(prDigest?.digestSummary||'')});",
        "}",
        "console.log(JSON.stringify({securityFailureCount:securityFailures.length,alertsFetched,needsAgentCount:needsAgent.length,needsAgent}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_FETCH_AND_CLASSIFY:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    }, { x: 120, y: 750 }),

    node("security-agent-needed", "condition.expression", "Needs Security Agent?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('programmatic-security-fix')?.output;" +
        "return (JSON.parse(o||'{}').needsAgentCount||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 120, y: 860 }),

    // ─────────────────────────────────────────────────────────────────────────
    // Per-PR parallel dispatch for security fixes — one dedicated agent per PR,
    // up to maxConcurrentFixes in parallel. Mirrors the generic fix path.
    // ─────────────────────────────────────────────────────────────────────────
    node("claim-unclaimed-security-prs", "action.run_command", "Claim Unclaimed Security PRs", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const raw=String(process.env.BOSUN_SECURITY_FIX||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const needsAgent=Array.isArray(payload.needsAgent)?payload.needsAgent:[];",
        "const TTL_MINUTES=Math.max(5,Number(process.env.PR_FIX_TTL_MINUTES||120));",
        "const TTL_MS=TTL_MINUTES*60*1000;",
        "const CLAIM_FILE=path.join(process.cwd(),'.cache','bosun','pr-security-fix-claims.json');",
        "const now=Date.now();",
        "let data={claims:{},updatedAt:new Date().toISOString()};",
        "try{fs.mkdirSync(path.dirname(CLAIM_FILE),{recursive:true});}catch{}",
        "try{if(fs.existsSync(CLAIM_FILE))data=JSON.parse(fs.readFileSync(CLAIM_FILE,'utf8'));}catch{}",
        "if(!data.claims)data.claims={};",
        "for(const[key,claim]of Object.entries(data.claims)){if(now-new Date(claim.claimedAt).getTime()>TTL_MS)delete data.claims[key];}",
        "const unclaimed=[];",
        "const alreadyClaimed=[];",
        "for(const item of needsAgent){",
        "  const key=String(item.repo||'')+'/'+String(item.number||'');",
        "  if(!key||key==='/'){continue;}",
        "  if(data.claims[key]){alreadyClaimed.push({key,...item});continue;}",
        "  data.claims[key]={claimedAt:new Date().toISOString(),repo:item.repo,number:item.number};",
        "  unclaimed.push({...item,claimKey:key,taskId:'pr-secfix-'+String(item.repo||'').replace(/[^a-z0-9]/gi,'-')+'-'+String(item.number||'')});",
        "}",
        "data.updatedAt=new Date().toISOString();",
        "try{fs.writeFileSync(CLAIM_FILE,JSON.stringify(data,null,2),'utf8');}catch{}",
        "console.log(JSON.stringify({unclaimedCount:unclaimed.length,alreadyClaimedCount:alreadyClaimed.length,unclaimed,alreadyClaimed}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_SECURITY_FIX:
          "{{$ctx.getNodeOutput('programmatic-security-fix')?.output || '{}'}}",
        PR_FIX_TTL_MINUTES: "{{prFixTtlMinutes}}",
      },
    }, { x: 120, y: 920 }),

    node("has-unclaimed-security-fixes", "condition.expression", "Unclaimed Security Fixes?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('claim-unclaimed-security-prs');" +
        "const d=typeof o?.output==='object'?o.output:JSON.parse(o?.output||'{}');" +
        "return (Array.isArray(d.unclaimed)?d.unclaimed:[]).length>0;" +
        "}catch(e){return false;}})()",
    }, { x: 120, y: 1010 }),

    node("dispatch-security-fix-agents", "loop.for_each", "Dispatch Security Fix Agents (Per PR)", {
      items:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('claim-unclaimed-security-prs');" +
        "const d=typeof o?.output==='object'?o.output:JSON.parse(o?.output||'{}');" +
        "return Array.isArray(d.unclaimed)?d.unclaimed:[];" +
        "}catch{return []}})()",
      variable: "item",
      maxConcurrent: "{{maxConcurrentFixes}}",
      mode: "dispatch",
      workflowId: "template-pr-security-fix-single",
    }, { x: 120, y: 1100 }),

    node("generic-fix-needed", "condition.expression", "Generic Fix Needed?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "const d=JSON.parse(o||'{}');" +
        "return ((d.conflicts||[]).length+(d.ciFailures||[]).length)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 280, y: 640 }),

    node("programmatic-fix", "action.run_command", "Programmatic Fix Pass", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const raw=String(process.env.BOSUN_FETCH_AND_CLASSIFY||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const ciFailures=Array.isArray(payload.ciFailures)?payload.ciFailures:[];",
        "const conflicts=Array.isArray(payload.conflicts)?payload.conflicts:[];",
        "const needsAgent=[];",
        "const pendingReruns=[];",
        "let rerunRequested=0;",
        "const FAIL_STATES=new Set(['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE']);",
        "const MAX_AUTO_RERUN_ATTEMPT=1;",
        GH_CLI_RESILIENCE_SNIPPET,
        "function normalizeRun(run){if(!run||typeof run!=='object')return null;return {databaseId:Number(run.databaseId||0)||null,attempt:Number(run.attempt||0)||0,conclusion:String(run.conclusion||''),status:String(run.status||''),workflowName:String(run.workflowName||run.name||''),displayTitle:String(run.displayTitle||run.name||''),url:String(run.url||''),createdAt:String(run.createdAt||''),updatedAt:String(run.updatedAt||'')}}",
        "function normalizeJob(job){if(!job||typeof job!=='object')return null;const steps=Array.isArray(job.steps)?job.steps:[];return {databaseId:Number(job.databaseId||job.id||0)||null,name:String(job.name||''),status:String(job.status||''),conclusion:String(job.conclusion||''),url:String(job.url||job.html_url||''),checkRunUrl:String(job.check_run_url||job.checkRunUrl||''),failedSteps:steps.filter((step)=>FAIL_STATES.has(String(step?.conclusion||step?.status||'').toUpperCase())).map((step)=>({name:String(step?.name||''),number:Number(step?.number||0)||null,status:String(step?.status||''),conclusion:String(step?.conclusion||'')})).filter((step)=>step.name).slice(0,10)}}",
        "function truncateText(value,max){const text=String(value||'').replace(/\\r/g,'').trim();if(!text)return '';return text.length>max?text.slice(0,Math.max(0,max-19))+'\\n...[truncated]':text;}",
        "function compactUser(user){const login=String(user?.login||user?.name||'').trim();return login?{login,url:String(user?.url||user?.html_url||'').trim()||null}:null;}",
        "function compactCheck(check){const name=String(check?.name||check?.context||check?.workflowName||'').trim();const state=String(check?.state||check?.conclusion||'').toUpperCase();const bucket=String(check?.bucket||'').toUpperCase();if(!name&&!state&&!bucket)return null;return {name:name||null,state:state||null,bucket:bucket||null,workflow:String(check?.workflowName||'').trim()||null};}",
        "function compactIssueComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactReview(review){return {id:Number(review?.id||0)||null,author:compactUser(review?.user||review?.author),state:String(review?.state||'').trim()||null,submittedAt:String(review?.submitted_at||review?.submittedAt||'').trim()||null,body:truncateText(review?.body,1200)};}",
        "function compactReviewComment(comment){return {id:Number(comment?.id||0)||null,author:compactUser(comment?.user||comment?.author),path:String(comment?.path||'').trim()||null,line:Number(comment?.line||0)||Number(comment?.original_line||0)||null,side:String(comment?.side||'').trim()||null,url:String(comment?.html_url||comment?.url||'').trim()||null,createdAt:String(comment?.created_at||comment?.createdAt||'').trim()||null,body:truncateText(comment?.body,1200)};}",
        "function compactFile(file){const path=String(file?.filename||file?.path||'').trim();return path?{path,status:String(file?.status||'').trim()||null,additions:Number(file?.additions||0)||0,deletions:Number(file?.deletions||0)||0,changes:Number(file?.changes||0)||0}:null;}",
        "function collectPrDigest(repo,number,fallback){const pr=safeGhJson(['pr','view',String(number),'--repo',repo,'--json','number,title,body,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,author,labels,reviewDecision'],{});const issueComments=safeGhJson(['api','repos/'+repo+'/issues/'+number+'/comments?per_page=100'],[]).map(compactIssueComment).slice(0,40);const reviews=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/reviews?per_page=100'],[]).map(compactReview).slice(0,40);const reviewComments=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/comments?per_page=100'],[]).map(compactReviewComment).slice(0,60);const files=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/files?per_page=100'],[]).map(compactFile).filter(Boolean).slice(0,80);const requested=safeGhJson(['api','repos/'+repo+'/pulls/'+number+'/requested_reviewers'],{});const requestedReviewers=[...(Array.isArray(requested?.users)?requested.users:[]).map(compactUser),...(Array.isArray(requested?.teams)?requested.teams:[]).map((team)=>{const slug=String(team?.slug||team?.name||'').trim();return slug?{team:slug,url:String(team?.html_url||team?.url||'').trim()||null}:null;})].filter(Boolean);const checks=(Array.isArray(pr.statusCheckRollup)?pr.statusCheckRollup:[]).map(compactCheck).filter(Boolean);const failingChecks=checks.filter((check)=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(check.state)||check.bucket==='FAIL');const pendingChecks=checks.filter((check)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(check.state));const labels=(Array.isArray(pr.labels)?pr.labels:[]).map((label)=>String(label?.name||label||'').trim()).filter(Boolean);const digestSummary=['PR #'+String(pr?.number||number)+' '+String(pr?.title||fallback?.title||''),'repo='+repo+' branch='+(String(pr?.headRefName||fallback?.branch||'').trim()||'unknown'),'checks='+checks.length+' fail='+failingChecks.length+' pending='+pendingChecks.length,'comments='+issueComments.length+' reviews='+reviews.length+' reviewComments='+reviewComments.length+' files='+files.length,labels.length?'labels='+labels.join(', '):''].filter(Boolean).join('\\n');return {core:{number:Number(pr?.number||number)||number,title:String(pr?.title||fallback?.title||''),url:String(pr?.url||fallback?.url||'').trim()||null,body:truncateText(pr?.body,4000),branch:String(pr?.headRefName||fallback?.branch||'').trim()||null,baseBranch:String(pr?.baseRefName||fallback?.base||'').trim()||null,isDraft:pr?.isDraft===true,mergeable:String(pr?.mergeable||'').trim()||null,author:compactUser(pr?.author),reviewDecision:String(pr?.reviewDecision||'').trim()||null},labels,requestedReviewers,checks,ciSummary:{total:checks.length,failing:failingChecks.length,pending:pendingChecks.length,passing:Math.max(0,checks.length-failingChecks.length-pendingChecks.length)},issueComments,reviews,reviewComments,files,digestSummary};}",
        "function normalizeCheckKey(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}",
        "function runMatchesFailedChecks(run,failedNames){const keys=(Array.isArray(failedNames)?failedNames:[]).map(normalizeCheckKey).filter(Boolean);if(!keys.length)return true;const names=[run?.workflowName,run?.displayTitle].map(normalizeCheckKey).filter(Boolean);return names.some((name)=>keys.some((key)=>name===key||name.includes(key)||key.includes(name)));}",
        GITHUB_CI_DIAGNOSTICS_SNIPPET,
        "for(const item of ciFailures){",
        "  const repo=String(item?.repo||'').trim();",
        "  const branch=String(item?.branch||'').trim();",
        "  const n=String(item?.n||'').trim();",
        "  const failedCheckNames=Array.isArray(item?.failedCheckNames)?item.failedCheckNames:[];",
        "  const url=String(item?.url||'').trim();",
        "  const title=String(item?.title||'').trim();",
        "  const prDigest=repo&&n?collectPrDigest(repo,n,{branch,title,url}):null;",
        "  if(!repo||!branch){needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'missing_repo_or_branch',prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  let runs=[];",
        "  try{",
        "    const listRaw=runGh(['run','list','--repo',repo,'--branch',branch,'--json','databaseId,attempt,conclusion,status,workflowName,displayTitle,url,createdAt,updatedAt','--limit','8']);",
        "    const parsedRuns=(()=>{try{return JSON.parse(listRaw||'[]')}catch{return []}})();",
        "    runs=Array.isArray(parsedRuns)?parsedRuns:[];",
        "  }catch(e){needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'ci_run_listing_failed',error:String(e?.message||e),prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  const normalizedRuns=runs.map(normalizeRun).filter(Boolean);",
        "  const relevantFailedRuns=normalizedRuns.filter((r)=>FAIL_STATES.has(String(r?.conclusion||'').toUpperCase())&&runMatchesFailedChecks(r,failedCheckNames));",
        "  const relevantPendingRuns=normalizedRuns.filter((r)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(String(r?.status||'').toUpperCase())&&runMatchesFailedChecks(r,failedCheckNames));",
        "  const failedRun=relevantFailedRuns[0]||normalizedRuns.find((r)=>FAIL_STATES.has(String(r?.conclusion||'').toUpperCase()));",
        "  const recentFailedRunCount=relevantFailedRuns.length||(failedRun?1:0);",
        "  if(relevantPendingRuns.length){pendingReruns.push({repo,number:n,branch,url,title,failedCheckNames,reason:'ci_rerun_pending',pendingRuns:relevantPendingRuns.slice(0,5),prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  if(failedRun?.databaseId&&failedRun.attempt<=MAX_AUTO_RERUN_ATTEMPT&&recentFailedRunCount<=MAX_AUTO_RERUN_ATTEMPT){",
        "    try{runGh(['run','rerun',String(failedRun.databaseId),'--repo',repo]);rerunRequested++;continue;}",
        "    catch(e){needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'ci_rerun_failed',error:String(e?.message||e),prDigest,digestSummary:String(prDigest?.digestSummary||''),...collectCiDiagnostics(repo,failedRun,runGh)});continue;}",
        "  }",
        "  if(failedRun?.databaseId){needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'auto_rerun_limit_reached',rerunAttempts:failedRun.attempt||0,recentFailedRunCount,prDigest,digestSummary:String(prDigest?.digestSummary||''),...collectCiDiagnostics(repo,failedRun,runGh)});continue;}",
        "  needsAgent.push({repo,number:n,branch,url,title,failedCheckNames,reason:'no_rerunnable_failed_run_found',recentRuns:normalizedRuns.slice(0,5),prDigest,digestSummary:String(prDigest?.digestSummary||'')});",
        "}",
        "let branchUpdated=0;",
        "for(const item of conflicts){",
        "  const repo=String(item?.repo||'').trim();",
        "  const n=String(item?.n||'').trim();",
        "  const branch=String(item?.branch||'').trim();",
        "  const base=String(item?.base||'').trim();",
        "  const mergeable=String(item?.mergeable||'').toUpperCase();",
        "  const prDigest=repo&&n?collectPrDigest(repo,n,{branch,base,url:String(item?.url||'')}):null;",
        "  if(!repo||!n){needsAgent.push({...item,reason:'missing_repo_or_pr',prDigest,digestSummary:String(prDigest?.digestSummary||'')});continue;}",
        "  if(mergeable==='BEHIND'){",
        "    try{",
        "      const headSha=JSON.parse(runGh(['pr','view',n,'--repo',repo,'--json','headRefOid'])).headRefOid;",
        "      const apiArgs=['api','-X','PUT','repos/'+repo+'/pulls/'+n+'/update-branch','--field','expected_head_sha='+headSha];",
        "      runGh(apiArgs);",
        "      branchUpdated++;",
        "    }catch(e){needsAgent.push({repo,number:n,branch,base,mergeable,reason:'branch_update_failed',error:String(e?.message||e),prDigest,digestSummary:String(prDigest?.digestSummary||'')});}",
        "    continue;",
        "  }",
        "  needsAgent.push({repo,number:n,branch,base,mergeable,reason:'merge_conflict_requires_code_resolution',prDigest,digestSummary:String(prDigest?.digestSummary||'')});",
        "}",
        "const fullPayload={rerunRequested,rerunPendingCount:pendingReruns.length,branchUpdated,ciFailureCount:ciFailures.length,conflictCount:conflicts.length,needsAgentCount:needsAgent.length,pendingReruns,needsAgent};",
        "const fs=require('fs');const path=require('path');",
        "const bosunHome=String(process.env.BOSUN_HOME||'').trim();",
        "const tmpDir=bosunHome?path.join(bosunHome,'tmp'):path.join(process.cwd(),'.cache','bosun');",
        "try{fs.mkdirSync(tmpDir,{recursive:true})}catch{}",
        "const tmpFile=path.join(tmpDir,'programmatic-fix-output.json');",
        "try{fs.writeFileSync(tmpFile,JSON.stringify(fullPayload),'utf8');process.stderr.write('[programmatic-fix] wrote '+tmpFile+' ('+JSON.stringify(fullPayload).length+' bytes)\\n')}catch(e){process.stderr.write('[programmatic-fix] failed to write temp file '+tmpFile+': '+String(e?.message||e)+'\\n')}",
        "console.log(JSON.stringify({rerunRequested,rerunPendingCount:pendingReruns.length,branchUpdated,ciFailureCount:ciFailures.length,conflictCount:conflicts.length,needsAgentCount:needsAgent.length,tmpFile}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_FETCH_AND_CLASSIFY:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    }, { x: 280, y: 750 }),

    node("fix-agent-needed", "condition.expression", "Needs Agent Fix?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('programmatic-fix')?.output;" +
        "return (JSON.parse(o||'{}').needsAgentCount||0)>0;" +
        "}catch(e){return false;}})()",
    }, { x: 280, y: 860 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3a: Claim unclaimed PRs — prevents duplicate work across watchdog
    // cycles. Each PR gets a time-locked claim (TTL=prFixTtlMinutes). If a
    // claim is active the PR is skipped; stale/expired claims are purged.
    // ─────────────────────────────────────────────────────────────────────────
    node("claim-unclaimed-prs", "action.run_command", "Claim & Filter Unclaimed PRs", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const bosunHome=String(process.env.BOSUN_HOME||'').trim();",
        "const tmpDir=bosunHome?path.join(bosunHome,'tmp'):path.join(process.cwd(),'.cache','bosun');",
        "const tmpFile=path.join(tmpDir,'programmatic-fix-output.json');",
        "let raw='';",
        "try{raw=fs.readFileSync(tmpFile,'utf8');}catch(e){process.stderr.write('[claim] cannot read temp file '+tmpFile+': '+String(e?.message||e)+'\\n');}",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const needsAgent=Array.isArray(payload.needsAgent)?payload.needsAgent:[];",
        "const TTL_MS=Math.max(60000,Number(process.env.PR_FIX_TTL_MINUTES||'120')*60*1000);",
        "const STALE_CLAIM_MS=Math.max(10*60*1000,Math.min(TTL_MS,20*60*1000));",
        "const CLAIM_DIR=tmpDir;",
        "const CLAIM_FILE=path.join(CLAIM_DIR,'pr-fix-claims.json');",
        "function loadClaims(){try{const d=JSON.parse(fs.readFileSync(CLAIM_FILE,'utf8'));return(d&&typeof d==='object'&&d.claims&&typeof d.claims==='object')?d.claims:{};}catch{return {};}}",
        "function saveClaims(claims){try{if(!fs.existsSync(CLAIM_DIR))fs.mkdirSync(CLAIM_DIR,{recursive:true});const data={version:1,claims,updatedAt:new Date().toISOString()};const tmp=CLAIM_FILE+'.tmp'+Date.now();fs.writeFileSync(tmp,JSON.stringify(data,null,2),'utf8');fs.renameSync(tmp,CLAIM_FILE);}catch(e){process.stderr.write('[claim] save error: '+String(e?.message||e)+'\\n');}}",
        "const now=Date.now();",
        "const claims=loadClaims();",
        "/* Purge expired or abandoned claims so stalled repair runs do not block retries for hours. */",
        "for(const key of Object.keys(claims)){const claim=claims[key]||{};const expiresAt=new Date(claim.expiresAt||0).getTime();const claimedAt=new Date(claim.claimedAt||0).getTime();const staleByAge=Number.isFinite(claimedAt)&&claimedAt>0&&(now-claimedAt)>=STALE_CLAIM_MS;if(now>expiresAt||staleByAge)delete claims[key];}",
        "const unclaimed=[];",
        "const alreadyClaimed=[];",
        "for(const item of needsAgent){",
        "  const repo=String(item?.repo||'').trim();",
        "  const number=String(item?.number||item?.n||'').trim();",
        "  if(!repo||!number){unclaimed.push({...item,taskId:'pr-fix-unknown',taskTitle:'Unknown PR',claimKey:''});continue;}",
        "  const key=repo+'#'+number;",
        "  const claim=claims[key];",
        "  if(claim&&now<new Date(claim.expiresAt||0).getTime()){",
        "    alreadyClaimed.push({key,repo,number,reason:item?.reason||'',claimedAt:claim.claimedAt,expiresAt:claim.expiresAt});",
        "    process.stderr.write('[pr-watchdog] '+key+' already claimed (claimed '+claim.claimedAt+', expires '+claim.expiresAt+'), skipping\\n');",
        "    continue;",
        "  }",
        "  const safeRepo=repo.replace(/[^a-z0-9]/gi,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');",
        "  const taskId='pr-fix-'+safeRepo+'-'+number;",
        "  const taskTitle='Fix PR #'+number+(item?.title?' \\''+String(item.title).slice(0,60)+'\\'':'')+' ('+repo+')';",
        "  claims[key]={repo,number,taskId,taskTitle,claimedAt:new Date().toISOString(),expiresAt:new Date(now+TTL_MS).toISOString()};",
        "  unclaimed.push({...item,taskId,taskTitle,number,repo,claimKey:key});",
        "}",
        "saveClaims(claims);",
        "console.log(JSON.stringify({unclaimed,alreadyClaimed,unclaimedCount:unclaimed.length,alreadyClaimedCount:alreadyClaimed.length,totalNeedsAgent:needsAgent.length}));",
      ].join(" ")],

      continueOnError: true,
      failOnError: false,
      env: {
        PR_FIX_TTL_MINUTES: "{{prFixTtlMinutes}}",
      },
    }, { x: 280, y: 970 }),

    node("has-unclaimed-fixes", "condition.expression", "Unclaimed Fixes?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('claim-unclaimed-prs');" +
        "const d=typeof o?.output==='object'?o.output:JSON.parse(o?.output||'{}');" +
        "return (Array.isArray(d.unclaimed)?d.unclaimed:[]).length>0;" +
        "}catch(e){return false;}})()",
    }, { x: 280, y: 1060 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3b: Per-PR parallel dispatch — one dedicated long-running agent per
    // PR (up to maxConcurrentFixes in parallel). Each agent is session-tracked
    // and has a 2-hour budget for complex fixes. The claim system prevents the
    // next watchdog cycle from re-dispatching PRs already in-flight.
    // ─────────────────────────────────────────────────────────────────────────
    node("dispatch-fix-agents", "loop.for_each", "Dispatch Fix Agents (Per PR)", {
      items:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('claim-unclaimed-prs');" +
        "const d=typeof o?.output==='object'?o.output:JSON.parse(o?.output||'{}');" +
        "return Array.isArray(d.unclaimed)?d.unclaimed:[];" +
        "}catch{return []}})()",
      variable: "item",
      maxConcurrent: "{{maxConcurrentFixes}}",
      mode: "dispatch",
      workflowId: "template-pr-fix-single",
    }, { x: 280, y: 1160 }),

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2b: Review gate — MANDATORY before any merge.
    // The review agent checks diff stats per candidate and is the ONLY thing
    // that can call `gh pr merge`. It blocks suspicious/destructive diffs.
    // ─────────────────────────────────────────────────────────────────────────
    node("review-needed", "condition.expression", "Review Candidates?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-and-classify')?.output;" +
        "return (JSON.parse(o||'{}').readyCandidates||[]).length>0;" +
        "}catch(e){return false;}})()",
    }, { x: 600, y: 530 }),

    node("programmatic-review", "action.run_command", "Review Gate: Programmatic Merge", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const {execFileSync}=require('child_process');",
        "const raw=String(process.env.BOSUN_FETCH_AND_CLASSIFY||'');",
        "const payload=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const candidates=Array.isArray(payload.readyCandidates)?payload.readyCandidates:[];",
        "const ratio=Number('{{suspiciousDeletionRatio}}')||3;",
        "const minDel=Number('{{minDestructiveDeletions}}')||500;",
        "const labelReview=String('{{labelNeedsReview}}'||'bosun-needs-human-review');",
        "const method=String('{{mergeMethod}}'||'merge').toLowerCase();",
        "const merged=[]; const held=[]; const skipped=[];",
        "function gh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "function normalizeList(value){if(Array.isArray(value)) return value.map((entry)=>String(entry||'').trim().toLowerCase()).filter(Boolean); return String(value||'').split(',').map((entry)=>entry.trim().toLowerCase()).filter(Boolean);}",
        "function parseBool(value,fallback){if(value===undefined||value===null||value==='') return fallback; const raw=String(value).trim().toLowerCase(); if(['1','true','yes','on'].includes(raw)) return true; if(['0','false','no','off'].includes(raw)) return false; return fallback;}",
        "function matchesCheckPattern(name,pattern){const text=String(name||'').trim().toLowerCase();const token=String(pattern||'').trim().toLowerCase();if(!text||!token)return false;if(token==='*')return true;if(!token.includes('*'))return text.includes(token);const parts=token.split('*').filter(Boolean);if(parts.length===0)return true;let cursor=0;for(const part of parts){const idx=text.indexOf(part,cursor);if(idx===-1)return false;cursor=idx+part.length;}if(!token.startsWith('*')&&!text.startsWith(parts[0]||''))return false;if(!token.endsWith('*')&&!text.endsWith(parts[parts.length-1]||''))return false;return true;}",
        "function matchesAnyPattern(name,patterns){return (Array.isArray(patterns)?patterns:[]).some((pattern)=>matchesCheckPattern(name,pattern));}",
        "function readCheckState(check){return String(check?.state||check?.conclusion||check?.bucket||'').trim().toUpperCase();}",
        "function isPassingCheckState(state,treatNeutralAsPass){if(!state)return true;if(['SUCCESS','PASS','PASSED','COMPLETED'].includes(state))return true;if(treatNeutralAsPass&&['NEUTRAL','SKIPPED'].includes(state))return true;return !['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(state)&&!['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(state);}",
        "function evaluateCheckGates(checks,policy){const normalized=(Array.isArray(checks)?checks:[]).map((check)=>({name:String(check?.name||'').trim(),state:readCheckState(check)})).filter((check)=>check.name);const considered=normalized.filter((check)=>!matchesAnyPattern(check.name,policy.ignorePatterns));let required=considered;if(policy.mode==='required-only'){required=considered.filter((check)=>matchesAnyPattern(check.name,policy.requiredPatterns));}if((Array.isArray(policy.optionalPatterns)?policy.optionalPatterns:[]).length>0){required=required.filter((check)=>!matchesAnyPattern(check.name,policy.optionalPatterns));}const missingRequired=policy.requireAnyRequiredCheck&&required.length===0;const hasFailure=required.some((check)=>['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(check.state));const hasPending=policy.treatPendingRequiredAsBlocking&&required.some((check)=>['QUEUED','IN_PROGRESS','PENDING','WAITING','REQUESTED'].includes(check.state));return {hasFailure,hasPending,missingRequired,noConsideredChecks:considered.length===0,isReady:!missingRequired&&!hasFailure&&!hasPending&&required.every((check)=>isPassingCheckState(check.state,policy.treatNeutralAsPass))};}",
        "function configPath(){const home=String(process.env.BOSUN_HOME||process.env.BOSUN_PROJECT_DIR||'').trim();return home?path.join(home,'bosun.config.json'):path.join(process.cwd(),'bosun.config.json');}",
        "function readBosunConfig(){try{return JSON.parse(fs.readFileSync(configPath(),'utf8'));}catch{return {};}}",
        "const BOSUN_CONFIG=readBosunConfig();",
        "const CHECK_GATES=(BOSUN_CONFIG&&typeof BOSUN_CONFIG.gates==='object'&&BOSUN_CONFIG.gates&&typeof BOSUN_CONFIG.gates.checks==='object')?BOSUN_CONFIG.gates.checks:{};",
        "const CHECK_MODE=((String(CHECK_GATES?.mode||'all').trim().toLowerCase())||'all');",
        "const REQUIRED_CHECK_PATTERNS=normalizeList(CHECK_GATES?.requiredPatterns);",
        "const OPTIONAL_CHECK_PATTERNS=normalizeList(CHECK_GATES?.optionalPatterns);",
        "const IGNORE_CHECK_PATTERNS=normalizeList(CHECK_GATES?.ignorePatterns);",
        "const REQUIRE_ANY_REQUIRED_CHECK=parseBool(CHECK_GATES?.requireAnyRequiredCheck, true);",
        "const TREAT_PENDING_REQUIRED_AS_BLOCKING=parseBool(CHECK_GATES?.treatPendingRequiredAsBlocking, true);",
        "const TREAT_NEUTRAL_AS_PASS=parseBool(CHECK_GATES?.treatNeutralAsPass, false);",
        "for(const c of candidates){",
        "  const repo=String(c?.repo||'').trim();",
        "  const n=String(c?.n||'').trim();",
        "  if(!repo||!n){skipped.push({repo,number:n,reason:'missing_repo_or_pr'});continue;}",
        "  try{",
        "    const viewRaw=gh(['pr','view',n,'--repo',repo,'--json','number,title,additions,deletions,changedFiles,isDraft']);",
        "    const view=(()=>{try{return JSON.parse(viewRaw||'{}')}catch{return {}}})();",
        "    if(view?.isDraft===true){skipped.push({repo,number:n,reason:'draft'});continue;}",
        "    const add=Number(view?.additions||0);",
        "    const del=Number(view?.deletions||0);",
        "    const changed=Number(view?.changedFiles||0);",
        "    const destructive=(del>(add*ratio))&&(del>minDel);",
        "    const tooWide=changed>250;",
        "    if(destructive||tooWide){",
        "      gh(['pr','edit',n,'--repo',repo,'--add-label',labelReview]);",
        "      gh(['pr','comment',n,'--repo',repo,'--body',':warning: Bosun held this PR for human review due to suspicious diff footprint.']);",
        "      held.push({repo,number:n,reason:destructive?'destructive_diff':'changed_files_too_large',additions:add,deletions:del,changedFiles:changed});",
        "      continue;",
        "    }",
        "    const checksRaw=gh(['pr','checks',n,'--repo',repo,'--json','name,state,bucket']);",
        "    const checks=(()=>{try{return JSON.parse(checksRaw||'[]')}catch{return []}})();",
        "    const gateVerdict=evaluateCheckGates(checks,{mode:CHECK_MODE,requiredPatterns:REQUIRED_CHECK_PATTERNS,optionalPatterns:OPTIONAL_CHECK_PATTERNS,ignorePatterns:IGNORE_CHECK_PATTERNS,requireAnyRequiredCheck:REQUIRE_ANY_REQUIRED_CHECK,treatPendingRequiredAsBlocking:TREAT_PENDING_REQUIRED_AS_BLOCKING,treatNeutralAsPass:TREAT_NEUTRAL_AS_PASS});",
        "    if(gateVerdict.hasFailure){skipped.push({repo,number:n,reason:'ci_failed'});continue;}",
        "    if(gateVerdict.hasPending){skipped.push({repo,number:n,reason:'ci_pending'});continue;}",
        "    if(gateVerdict.missingRequired){skipped.push({repo,number:n,reason:'no_required_checks'});continue;}",
        "    if(gateVerdict.noConsideredChecks){skipped.push({repo,number:n,reason:'no_checks_yet'});continue;}",
        "    const doApplySuggestions=String('{{autoApplySuggestions}}'||'true')==='true'&&process.env.BOSUN_AUTO_APPLY_SUGGESTIONS!=='false';",
        "    if(doApplySuggestions){",
        "      try{",
        "        const toolPath=require('path').resolve(process.cwd(),'tools','apply-pr-suggestions.mjs');",
        "        if(require('fs').existsSync(toolPath)){",
        "          const sugOut=execFileSync('node',[toolPath,'--owner',repo.split('/')[0],'--repo',repo.split('/')[1],n,'--json'],{encoding:'utf8',timeout:60000,stdio:['pipe','pipe','pipe']});",
        "          const sugRes=(()=>{try{return JSON.parse(sugOut)}catch{return null}})();",
        "          if(sugRes?.commitSha){console.error('[watchdog] auto-applied '+sugRes.applied+' suggestion(s) on PR #'+n+' → '+sugRes.commitSha.slice(0,8));skipped.push({repo,number:n,reason:'suggestions_applied_awaiting_ci'});continue;}",
        "        }",
        "      }catch(sugErr){console.error('[watchdog] suggestion auto-apply skipped for PR #'+n+': '+String(sugErr?.message||sugErr).slice(0,120));}",
        "    }",
        "    const mergeArgs=['pr','merge',n,'--repo',repo,'--delete-branch'];",
        "    if(method==='rebase') mergeArgs.push('--rebase');",
        "    else if(method==='merge') mergeArgs.push('--merge');",
        "    else mergeArgs.push('--squash');",
        "    try{gh(mergeArgs);}catch(directErr){",
        "      mergeArgs.push('--auto');",
        "      gh(mergeArgs);",
        "    }",
        "    merged.push({repo,number:n,title:String(view?.title||'')});",
        "  }catch(e){",
        "    held.push({repo,number:n,reason:'merge_attempt_failed',error:String(e?.message||e)});",
        "  }",
        "}",
        "console.log(JSON.stringify({mergedCount:merged.length,heldCount:held.length,skippedCount:skipped.length,merged,held,skipped}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_FETCH_AND_CLASSIFY:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    }, { x: 600, y: 700 }),

    node("notify", "notify.log", "Watchdog Report", {
      message:
        "Bosun PR Watchdog cycle complete — see live digest/status board for streaming updates",
      level: "info",
    }, { x: 400, y: 900 }),

    // ── Pause / resume task-spawning workflows while PR repairs are active ──
    // Prevents Task Lifecycle from spawning new tasks while fix-agents are
    // repairing open PRs, avoiding resource contention and wasted worktrees.
    node("pause-task-spawning", "action.run_command", "Pause Task Spawning", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs'),path=require('path');",
        "const wfDir=path.resolve(process.env.BOSUN_CONFIG_DIR||'.bosun','workflows');",
        "const PAUSE_TARGETS=['template-task-lifecycle','template-task-batch-processor'];",
        "if(!fs.existsSync(wfDir)){process.exit(0);}",
        "let paused=0;",
        "for(const f of fs.readdirSync(wfDir).filter(f=>f.endsWith('.json'))){",
        "  try{const fp=path.join(wfDir,f);const def=JSON.parse(fs.readFileSync(fp,'utf8'));",
        "  const tmpl=String(def?.metadata?.installedFrom||'').trim();",
        "  if(!PAUSE_TARGETS.includes(tmpl))continue;",
        "  if(def.enabled===false&&def.metadata?.pausedByWorkflow)continue;",
        "  def.enabled=false;def.metadata=def.metadata||{};",
        "  def.metadata.pausedByWorkflow='template-bosun-pr-watchdog';",
        "  def.metadata.pausedAt=new Date().toISOString();",
        "  fs.writeFileSync(fp,JSON.stringify(def,null,2),'utf8');paused++;}catch{}",
        "}",
        "console.log(JSON.stringify({paused}));",
      ].join("")],
      continueOnError: true,
      failOnError: false,
    }, { x: 50, y: 560 }),

    node("resume-task-spawning", "action.run_command", "Resume Task Spawning", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs'),path=require('path');",
        "const wfDir=path.resolve(process.env.BOSUN_CONFIG_DIR||'.bosun','workflows');",
        "if(!fs.existsSync(wfDir)){process.exit(0);}",
        "let resumed=0;",
        "for(const f of fs.readdirSync(wfDir).filter(f=>f.endsWith('.json'))){",
        "  try{const fp=path.join(wfDir,f);const def=JSON.parse(fs.readFileSync(fp,'utf8'));",
        "  if(def.metadata?.pausedByWorkflow!=='template-bosun-pr-watchdog')continue;",
        "  def.enabled=true;delete def.metadata.pausedByWorkflow;delete def.metadata.pausedAt;",
        "  fs.writeFileSync(fp,JSON.stringify(def,null,2),'utf8');resumed++;}catch{}",
        "}",
        "console.log(JSON.stringify({resumed}));",
      ].join("")],
      continueOnError: true,
      failOnError: false,
    }, { x: 700, y: 560 }),

    node("no-prs", "notify.log", "No Bosun PRs Open", {
      message: "Bosun PR Watchdog: no open automation-eligible PRs found — idle",
      level: "info",
    }, { x: 700, y: 370 }),

    // ── Sweep: delete remote branches for already-merged PRs ────────────
    // Squash merges leave orphan branches because --auto defers deletion.
    // This node runs after the merge gate and prunes any lingering heads.
    node("cleanup-merged-branches", "action.run_command", "Prune Merged Branches", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "function gh(a){return execFileSync('gh',a,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
        "const repos=String(process.env.BOSUN_REPO_LIST||'').split(',').map(s=>s.trim()).filter(Boolean);",
        "let deleted=0;",
        "for(const repo of repos){",
        "  try{",
        "    const raw=gh(['pr','list','--repo',repo,'--state','merged','--json','number,headRefName,labels','--limit','50']);",
        "    const prs=(()=>{try{return JSON.parse(raw||'[]')}catch{return []}})();",
        "    for(const pr of prs){",
        "      const labels=Array.isArray(pr?.labels)?pr.labels.map((entry)=>typeof entry==='string'?entry:entry?.name).filter(Boolean):[];",
        "      if(!labels.includes('bosun-pr-bosun-created')) continue;",
        "      const branch=String(pr?.headRefName||'').trim();",
        "      if(!branch||branch==='main'||branch==='master')continue;",
        "      try{gh(['api','repos/'+repo+'/git/refs/heads/'+branch,'--method','DELETE','--silent']);deleted++;}catch(e){}",
        "    }",
        "  }catch(e){}",
        "}",
        "console.log(JSON.stringify({deletedBranches:deleted}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_REPO_LIST:
          "{{$ctx.getNodeOutput('fetch-and-classify')?.output ? (()=>{try{const o=JSON.parse($ctx.getNodeOutput('fetch-and-classify').output);return [...new Set([...(o.fixCandidates||[]),...(o.readyCandidates||[])].map(c=>c.repo).filter(Boolean))].join(',')}catch{return ''}})() : ''}}",
      },
    }, { x: 400, y: 1020 }),
  ],
  edges: [
    edge("trigger",          "fetch-and-classify"),
    edge("fetch-and-classify","has-prs"),
    edge("has-prs",          "has-behind",      { condition: "$output?.result === true" }),
    edge("has-prs",          "no-prs",          { condition: "$output?.result !== true" }),
    // Parallel merge path — review CLEAN PRs immediately, don't wait for fix agent
    edge("has-prs",          "review-needed",   { condition: "$output?.result === true" }),
    // Behind-branch fast-path: update out-of-date PRs without agent dispatch
    edge("has-behind",       "update-behind-branches", { condition: "$output?.result === true", port: "yes" }),
    edge("has-behind",       "fix-needed",      { condition: "$output?.result !== true", port: "no" }),
    edge("update-behind-branches", "fix-needed"),
    // Fix path (security failures, then conflicts + non-security CI failures)
    edge("fix-needed",       "pause-task-spawning",     { condition: "$output?.result === true" }),
    edge("fix-needed",       "review-needed",           { condition: "$output?.result !== true" }),
    edge("pause-task-spawning", "security-fix-needed"),
    edge("security-fix-needed","programmatic-security-fix", { condition: "$output?.result === true" }),
    edge("security-fix-needed","generic-fix-needed",       { condition: "$output?.result !== true" }),
    edge("programmatic-security-fix", "security-agent-needed"),
    edge("security-agent-needed", "claim-unclaimed-security-prs", { condition: "$output?.result === true" }),
    edge("security-agent-needed", "generic-fix-needed",         { condition: "$output?.result !== true" }),
    edge("claim-unclaimed-security-prs", "has-unclaimed-security-fixes"),
    edge("has-unclaimed-security-fixes", "dispatch-security-fix-agents", { condition: "$output?.result === true" }),
    edge("has-unclaimed-security-fixes", "generic-fix-needed",          { condition: "$output?.result !== true" }),
    edge("dispatch-security-fix-agents", "generic-fix-needed"),
    edge("generic-fix-needed", "programmatic-fix", { condition: "$output?.result === true" }),
    edge("generic-fix-needed", "review-needed",    { condition: "$output?.result !== true" }),
    edge("programmatic-fix", "fix-agent-needed"),
    edge("fix-agent-needed", "claim-unclaimed-prs", { condition: "$output?.result === true" }),
    edge("fix-agent-needed", "review-needed",      { condition: "$output?.result !== true" }),
    edge("claim-unclaimed-prs", "has-unclaimed-fixes"),
    edge("has-unclaimed-fixes", "dispatch-fix-agents", { condition: "$output?.result === true" }),
    edge("has-unclaimed-fixes", "review-needed",       { condition: "$output?.result !== true" }),
    edge("dispatch-fix-agents","review-needed"),
    // Review gate (merge candidates)
    edge("review-needed",    "programmatic-review", { condition: "$output?.result === true" }),
    edge("review-needed",    "notify",          { condition: "$output?.result !== true" }),
    edge("programmatic-review","notify"),
    // Post-merge cleanup — resume task spawning (idempotent) then prune branches
    edge("notify",           "resume-task-spawning"),
    edge("no-prs",           "resume-task-spawning"),
    edge("resume-task-spawning", "cleanup-merged-branches"),
  ],
  metadata: {
    author: "bosun",
    version: 6,
    createdAt: "2025-07-01T00:00:00Z",
    templateVersion: "3.1.0",
    tags: ["github", "pr", "ci", "merge", "watchdog", "bosun-attached", "safety"],
    replaces: {
      module: "agent-hooks.mjs",
      functions: ["registerBuiltinHooks (PostPR block)"],
      calledFrom: [],
      description:
        "v3.1: Adds pause/resume of Task Lifecycle and Task Batch Processor while PR " +
        "fix-agents are in-flight, preventing resource contention from new task spawning. " +
        "v3.0: Replaces single mega-agent dispatch with per-PR claim system and parallel fan-out. " +
        "Each PR gets its own dedicated agent (template-pr-fix-single) with 2-hour budget. " +
        "PR claims prevent duplicate work across watchdog cycles (TTL=prFixTtlMinutes). " +
        "All per-PR agents are session-tracked in Fleet/Sessions. " +
        "v2.3: Adds fast-path update-branch for out-of-date (BEHIND) PRs without conflicts. " +
        "Consolidates PR polling into one gh pr list fetch per target repo per cycle. " +
        "Uses deterministic-first remediation and review/merge command nodes; " +
        "agent execution is now fallback-only for unresolved conflicts or failed " +
        "automatic remediation attempts. All external PRs (no bosun-attached label) " +
        "remain untouched.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PR Fix Agent — Single PR
//  Invoked by the PR Watchdog's loop.for_each per-PR dispatch. Handles ONE
//  PR with a dedicated long-running agent session (up to 2 hours). Receives
//  the PR item as ctx.data.item from the loop parent.
//
//  Key properties:
//   - Sets a stable taskId (pr-fix-<repo>-<number>) so the agent run is
//     tracked as a named session in Fleet/Sessions across watchdog cycles.
//   - Releases the PR claim on completion (allows re-claim after TTL anyway,
//     but explicit release makes the slot available immediately on success).
//   - continueOnSession: true — if the process crashes mid-run, the next
//     watchdog cycle can resume rather than restart from scratch.
// ═══════════════════════════════════════════════════════════════════════════

const PR_STATE_VIEW_FIELDS = "state,isDraft,headRefName,baseRefName,url,mergedAt,closedAt";

function makeValidatePrStateScript() {
  return [
    "const {execFileSync}=require('child_process');",
    "const repo=String(process.env.PR_REPO||'').trim();",
    "const num=String(process.env.PR_NUMBER||'0').trim();",
    "const fallbackBranch=String(process.env.PR_BRANCH||'').trim();",
    "const fallbackBase=String(process.env.PR_BASE||'main').trim();",
    "if(!repo||!num){console.log(JSON.stringify({ok:false,open:false,skip:true,reason:'missing_repo_or_number',repo,number:num,branch:fallbackBranch,base:fallbackBase}));process.exit(0);}",
    "try{",
    `  const raw=execFileSync('gh',['pr','view',num,'--repo',repo,'--json','${PR_STATE_VIEW_FIELDS}'],{encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30000}).trim();`,
    "  const view=JSON.parse(raw||'{}');",
    "  const state=String(view?.state||'').trim().toUpperCase();",
    "  const isDraft=view?.isDraft===true;",
    "  const mergedAt=String(view?.mergedAt||'').trim()||null;",
    "  const closedAt=String(view?.closedAt||'').trim()||null;",
    "  const merged=state==='MERGED'||Boolean(mergedAt);",
    "  const open=state==='OPEN'&&!isDraft;",
    "  const branch=String(view?.headRefName||fallbackBranch||'').trim();",
    "  const base=String(view?.baseRefName||fallbackBase||'main').trim()||'main';",
    "  const targetTaskStatus=merged?'done':(state==='CLOSED'?'cancelled':null);",
    "  const shouldResolveTask=Boolean(targetTaskStatus);",
    "  const reason=open?'open':(merged?'pr_merged':(state==='CLOSED'?'pr_closed':(isDraft?'draft_pr':'pr_not_open')));",
    "  console.log(JSON.stringify({ok:open,open,skip:!open,reason,state,isDraft,merged,mergedAt,closedAt,shouldResolveTask,targetTaskStatus,repo,number:num,branch,base,url:String(view?.url||'').trim()||null}));",
    "}catch(err){",
    "  console.log(JSON.stringify({ok:false,open:false,skip:true,reason:'pr_view_failed',error:String(err?.message||err),repo,number:num,branch:fallbackBranch,base:fallbackBase}));",
    "}",
  ];
}

function makeResolvePrTaskScript() {
  return [
    "const fs=require('fs');",
    "const path=require('path');",
    "const {execFileSync}=require('child_process');",
    "const taskId=String(process.env.TASK_ID||'').trim();",
    "const repo=String(process.env.PR_REPO||'').trim();",
    "const num=String(process.env.PR_NUMBER||'').trim();",
    "const branch=String(process.env.PR_BRANCH||'').trim();",
    "const url=String(process.env.PR_URL||'').trim();",
    "const state=String(process.env.PR_STATE||'').trim().toUpperCase();",
    "const mergedAt=String(process.env.PR_MERGED_AT||'').trim()||null;",
    "const closedAt=String(process.env.PR_CLOSED_AT||'').trim()||null;",
    "const reason=String(process.env.PR_REASON||'').trim();",
    "const explicitStatus=String(process.env.TARGET_TASK_STATUS||'').trim().toLowerCase();",
    "const targetTaskStatus=explicitStatus||(state==='MERGED'||mergedAt?'done':(state==='CLOSED'?'cancelled':''));",
    "const cliPath=fs.existsSync('cli.mjs')?'cli.mjs':'';",
    "const taskCli=['task/task-cli.mjs','task-cli.mjs'].find(p=>fs.existsSync(p))||'';",
    "const taskRunner=cliPath?'cli':(taskCli?'task-cli':'');",
    "const maxBuffer=25*1024*1024;",
    "function parseJson(raw,fallback){try{return JSON.parse(String(raw||''));}catch{return fallback;}}",
    "function runTask(args){const cmdArgs=taskRunner==='cli'?['cli.mjs','task',...args,'--config-dir','.bosun','--repo-root','.']:[taskCli,...args];return execFileSync('node',cmdArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer}).trim();}",
    "if(!taskRunner){console.log(JSON.stringify({resolved:false,skipped:true,reason:'task_command_missing',taskId,targetTaskStatus,repo,number:num}));process.exit(0);}",
    "if(!taskId||!targetTaskStatus){console.log(JSON.stringify({resolved:false,skipped:true,reason:'missing_task_or_status',taskId,targetTaskStatus,repo,number:num}));process.exit(0);}",
    "let snapshot=null;",
    "try{snapshot=parseJson(runTask(['get',taskId,'--json']),null);}catch(err){console.log(JSON.stringify({resolved:false,skipped:true,reason:'task_lookup_failed',taskId,targetTaskStatus,error:String(err?.message||err)}));process.exit(0);}",
    "if(!snapshot||typeof snapshot!=='object'){console.log(JSON.stringify({resolved:false,skipped:true,reason:'task_not_found',taskId,targetTaskStatus}));process.exit(0);}",
    "const previousStatus=String(snapshot?.status||'').trim().toLowerCase()||null;",
    "const existingComments=Array.isArray(snapshot?.comments)?snapshot.comments:(Array.isArray(snapshot?.meta?.comments)?snapshot.meta.comments:[]);",
    "const resolutionKey='pr-resolution:'+repo+'#'+num+':'+targetTaskStatus;",
    "const alreadyCommented=existingComments.some((comment)=>String(comment?.meta?.resolutionKey||'').trim()===resolutionKey);",
    "const timestamp=new Date().toISOString();",
    "const prLabel=num?'PR #'+num:'associated PR';",
    "let message='';",
    "if(targetTaskStatus==='done'){message=prLabel+(url?' ('+url+')':'')+' was merged'+(mergedAt?' at '+mergedAt:'')+'. Bosun marked this task done because head branch `'+(branch||'?')+'` is no longer available on GitHub.';}",
    "else if(targetTaskStatus==='cancelled'){message=prLabel+(url?' ('+url+')':'')+' was closed without merge'+(closedAt?' at '+closedAt:'')+'. Bosun cancelled this task because head branch `'+(branch||'?')+'` is no longer available on GitHub.';}",
    "else{message=prLabel+(url?' ('+url+')':'')+' changed state to '+(state||'unknown')+'.';}",
    "if(reason) message+=' Resolution trigger: '+reason+'.';",
    "const nextComments=alreadyCommented?existingComments:[...existingComments,{body:message,author:'bosun',source:'workflow',kind:'pr-resolution',createdAt:timestamp,meta:{resolutionKey,repo,number:num||null,url:url||null,state:state||null,targetTaskStatus,branch:branch||null,reason:reason||null}}];",
    "const existingMeta=snapshot?.meta&&typeof snapshot.meta==='object'?snapshot.meta:{};",
    "const patch={status:targetTaskStatus,comments:nextComments,meta:{...existingMeta,lastPrResolution:{repo:repo||null,number:num||null,url:url||null,state:state||null,targetTaskStatus,branch:branch||null,reason:reason||null,mergedAt,closedAt,resolvedAt:timestamp}}};",
    "runTask(['update',taskId,JSON.stringify(patch)]);",
    "console.log(JSON.stringify({resolved:true,taskId,targetTaskStatus,previousStatus,commentAdded:!alreadyCommented,repo,number:num,url:url||null,state:state||null,reason:reason||null}));",
  ];
}

function makeSetupWorktreeScript(tempPrefix) {
  return [
    "const os=require('os');",
    "const path=require('path');",
    "const fs=require('fs');",
    "const {execFileSync}=require('child_process');",
    "const repo=String(process.env.PR_REPO||'').trim();",
    "const branch=String(process.env.PR_BRANCH||'').trim();",
    "const base=String(process.env.PR_BASE||'main').trim();",
    "const num=String(process.env.PR_NUMBER||'0').trim();",
    "if(!repo||!branch){console.log(JSON.stringify({error:'missing repo or branch',repo,branch}));process.exit(1);}",
    `let wt=path.join(os.tmpdir(),'${tempPrefix}-'+num.replace(/[^0-9a-z]/gi,'-'));`,
    "function readErr(err){return [String(err?.message||''),String(err?.stderr||''),String(err?.stdout||'')].filter(Boolean).join(' ');}",
    "function isMissingBranchError(err){const text=readErr(err);return /remote branch .* not found|couldn't find remote ref|remote ref does not exist|invalid reference: origin\\//i.test(text);}",
    "function viewPrState(){",
    "  try{",
    `    const raw=execFileSync('gh',['pr','view',num,'--repo',repo,'--json','${PR_STATE_VIEW_FIELDS}'],{encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30000}).trim();`,
    "    const view=JSON.parse(raw||'{}');",
    "    const state=String(view?.state||'').trim().toUpperCase();",
    "    const mergedAt=String(view?.mergedAt||'').trim()||null;",
    "    const closedAt=String(view?.closedAt||'').trim()||null;",
    "    const merged=state==='MERGED'||Boolean(mergedAt);",
    "    const targetTaskStatus=merged?'done':(state==='CLOSED'?'cancelled':null);",
    "    return {state,merged,mergedAt,closedAt,targetTaskStatus,shouldResolveTask:Boolean(targetTaskStatus),url:String(view?.url||'').trim()||null,branch:String(view?.headRefName||branch||'').trim()||branch,base:String(view?.baseRefName||base||'main').trim()||base||'main'};",
    "  }catch(err){",
    "    return {state:null,merged:false,mergedAt:null,closedAt:null,targetTaskStatus:null,shouldResolveTask:false,url:null,branch,base,error:String(err?.message||err)};",
    "  }",
    "}",
    "try{",
    "  let reused=false;",
    "  if(fs.existsSync(path.join(wt,'.git'))){",
    "    try{",
    "      const cur=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
    "      if(cur===branch){",
    "        execFileSync('git',['fetch','origin',branch],{cwd:wt,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});",
    "        execFileSync('git',['reset','--hard','origin/'+branch],{cwd:wt,encoding:'utf8',timeout:30000});",
    "        execFileSync('git',['clean','-fd','-e','.bosun/'],{cwd:wt,encoding:'utf8',timeout:30000});",
    "        try{execFileSync('git',['fetch','origin',base],{cwd:wt,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});}catch{}",
    "        reused=true;",
    "      }else{try{fs.rmSync(wt,{recursive:true,force:true});}catch{}}",
    "    }catch(err){",
    "      if(isMissingBranchError(err)){const prState=viewPrState();if(prState.shouldResolveTask){console.log(JSON.stringify({skip:true,reason:'head_branch_missing_after_pr_resolution',repo,number:num,...prState}));process.exit(0);}}",
    "      try{fs.rmSync(wt,{recursive:true,force:true});}catch{}",
    "      throw err;",
    "    }",
    "  }",
    "  if(!reused){",
    "    if(fs.existsSync(wt)){try{fs.rmSync(wt,{recursive:true,force:true});}catch{wt=wt+'-'+Date.now().toString(36);}}",
    "    execFileSync('gh',['repo','clone',repo,wt,'--','--branch',branch],{encoding:'utf8',timeout:300000,stdio:'inherit'});",
    "    execFileSync('git',['fetch','origin',branch],{cwd:wt,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});",
    "    execFileSync('git',['reset','--hard','origin/'+branch],{cwd:wt,encoding:'utf8',timeout:30000});",
    "    try{execFileSync('git',['fetch','origin',base],{cwd:wt,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});}catch{}",
    "  }",
    "  const finalBranch=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
    "  if(finalBranch!==branch){console.error('Branch mismatch: expected '+branch+' got '+finalBranch);process.exit(1);}",
    "  console.log(JSON.stringify({worktreePath:wt,branch:finalBranch,base,repo,number:num,reused,skip:false}));",
    "}catch(err){",
    "  if(isMissingBranchError(err)){const prState=viewPrState();if(prState.shouldResolveTask){console.log(JSON.stringify({skip:true,reason:'head_branch_missing_after_pr_resolution',repo,number:num,...prState}));process.exit(0);}}",
    "  console.error(readErr(err)||String(err?.message||err));",
    "  process.exit(1);",
    "}",
  ];
}

resetLayout();

export const PR_FIX_SINGLE_TEMPLATE = {
  id: "template-pr-fix-single",
  name: "PR Fix Agent (Single PR)",
  description:
    "Fixes one Bosun-attached PR using a dedicated long-running agent (up to 2 hours). " +
    "Dispatched by the PR Watchdog loop for each unclaimed PR needing repair. " +
    "Programmatically clones the target repo and checks out the PR's HEAD branch " +
    "into a temp worktree, runs the agent there, then pushes fixes back with " +
    "--force-with-lease and cleans up. The agent NEVER manages git setup or push.",
  category: "github",
  enabled: true,
  recommended: true,
  core: true,
  trigger: "trigger.manual",
  variables: {},
  nodes: [
    node("trigger", "trigger.manual", "Start"),

    // ── 1. Establish stable per-PR task identity ─────────────────────────────
    node("setup-task", "action.set_variable", "Setup PR Task ID", {
      key: "taskId",
      value:
        "'pr-fix-' + " +
        "String($data?.item?.taskId || " +
        "  (String($data?.item?.repo || '').replace(/[^a-z0-9]/gi, '-').replace(/-+/g,'-').replace(/^-|-$/g,'') + " +
        "   '-' + String($data?.item?.number || $data?.item?.n || '0'))).replace(/^-|-$/g, '')",
      isExpression: true,
    }),

    node("setup-title", "action.set_variable", "Setup PR Task Title", {
      key: "taskTitle",
      value:
        "'Fix PR #' + String($data?.item?.number || $data?.item?.n || '?') + " +
        "($data?.item?.title ? ' \\'' + String($data.item.title).slice(0,60) + '\\'' : '') + " +
        "' (' + String($data?.item?.repo || '') + ')'",
      isExpression: true,
    }),

    node("setup-claim-key", "action.set_variable", "Setup Claim Key", {
      key: "claimKey",
      value: "String($data?.item?.claimKey || '')",
      isExpression: true,
    }),

    // ── 1b. Pre-resolve PR parameters with full fallback chains ──────────────
    // ctx.resolve() only handles {{template}} syntax — it cannot evaluate IIFEs.
    // Use set_variable + isExpression to compute values before passing to env.
    node("resolve-pr-params", "action.set_variable", "Resolve PR Parameters", {
      key: "prParams",
      value:
        "({" +
        "repo: String($data?.item?.repo || $data?.item?.prDigest?.core?.repo || ''), " +
        "branch: String($data?.item?.prDigest?.core?.branch || $data?.item?.branch || ''), " +
        "base: String($data?.item?.base || $data?.item?.baseBranch || $data?.item?.prDigest?.core?.baseBranch || 'main'), " +
        "number: String($data?.item?.number || $data?.item?.n || '0'), " +
        "reason: String($data?.item?.reason || ''), " +
        "mergeable: String($data?.item?.mergeable || $data?.item?.prDigest?.core?.mergeable || '')" +
        "})",
      isExpression: true,
      }),

    node("validate-pr-state", "action.run_command", "Validate PR Is Still Open", {
      command: "node",
      args: ["-e", makeValidatePrStateScript().join(" ")],
      parseJson: true,
      continueOnError: true,
      failOnError: false,
      timeoutMs: 60_000,
      env: {
        PR_REPO:   "{{prParams.repo}}",
        PR_BRANCH: "{{prParams.branch}}",
        PR_BASE:   "{{prParams.base}}",
        PR_NUMBER: "{{prParams.number}}",
      },
    }),

    node("resolve-pr-task", "action.run_command", "Resolve Task For Closed or Merged PR", {
      command: "node",
      args: ["-e", makeResolvePrTaskScript().join(" ")],
      parseJson: true,
      continueOnError: true,
      failOnError: false,
      timeoutMs: 60_000,
      env: {
        TASK_ID: "{{taskId}}",
        PR_REPO: "{{$ctx.getNodeOutput('setup-worktree')?.output?.repo || $ctx.getNodeOutput('validate-pr-state')?.output?.repo || $data?.prParams?.repo || ''}}",
        PR_NUMBER: "{{$ctx.getNodeOutput('setup-worktree')?.output?.number || $ctx.getNodeOutput('validate-pr-state')?.output?.number || $data?.prParams?.number || ''}}",
        PR_BRANCH: "{{$ctx.getNodeOutput('setup-worktree')?.output?.branch || $ctx.getNodeOutput('validate-pr-state')?.output?.branch || $data?.prParams?.branch || ''}}",
        PR_URL: "{{$ctx.getNodeOutput('setup-worktree')?.output?.url || $ctx.getNodeOutput('validate-pr-state')?.output?.url || $data?.item?.url || $data?.item?.prDigest?.core?.url || ''}}",
        PR_STATE: "{{$ctx.getNodeOutput('setup-worktree')?.output?.state || $ctx.getNodeOutput('validate-pr-state')?.output?.state || ''}}",
        PR_MERGED_AT: "{{$ctx.getNodeOutput('setup-worktree')?.output?.mergedAt || $ctx.getNodeOutput('validate-pr-state')?.output?.mergedAt || ''}}",
        PR_CLOSED_AT: "{{$ctx.getNodeOutput('setup-worktree')?.output?.closedAt || $ctx.getNodeOutput('validate-pr-state')?.output?.closedAt || ''}}",
        TARGET_TASK_STATUS: "{{$ctx.getNodeOutput('setup-worktree')?.output?.targetTaskStatus || $ctx.getNodeOutput('validate-pr-state')?.output?.targetTaskStatus || ''}}",
        PR_REASON: "{{$ctx.getNodeOutput('setup-worktree')?.output?.reason || $ctx.getNodeOutput('validate-pr-state')?.output?.reason || ''}}",
      },
    }),

    // ── 2. Programmatic worktree setup ───────────────────────────────────────
    // Clones or reuses a temp checkout on the PR's HEAD branch. The agent never
    // needs to clone, checkout, or manage git state — it just fixes code.
    node("setup-worktree", "action.run_command", "Clone & Checkout PR Branch", {
      command: "node",
      args: ["-e", makeSetupWorktreeScript("bosun-prfix").join(" ")],
      parseJson: true,
      failOnError: true,
      timeoutMs: 600_000,   // 10 min for clone
      env: {
        PR_REPO:   "{{$ctx.getNodeOutput('validate-pr-state')?.output?.repo || $data?.prParams?.repo || ''}}",
        PR_BRANCH: "{{$ctx.getNodeOutput('validate-pr-state')?.output?.branch || $data?.prParams?.branch || ''}}",
        PR_BASE:   "{{$ctx.getNodeOutput('validate-pr-state')?.output?.base || $data?.prParams?.base || ''}}",
        PR_NUMBER: "{{$ctx.getNodeOutput('validate-pr-state')?.output?.number || $data?.prParams?.number || ''}}",
      },
    }),

    // ── 2b. Expose worktreePath so action.run_agent uses it as cwd ───────────
    node("set-worktree-path", "action.set_variable", "Set Agent Working Directory", {
      key: "worktreePath",
      value: "{{setup-worktree.output.worktreePath}}",
    }),

    // ── 2c. Detect specific merge conflict files ─────────────────────────────
    // Attempts `git merge --no-commit` in the worktree to discover which files
    // conflict, then aborts the merge. Gives the agent exact file-level context
    // (like a human reviewer listing conflicting files in a PR comment).
    node("detect-conflicts", "action.run_command", "Detect Merge Conflict Files", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const wt=String(process.env.WORKTREE_PATH||'').trim();",
        "const base=String(process.env.PR_BASE||'main').trim();",
        "const reason=String(process.env.ITEM_REASON||'').trim();",
        "const mergeable=String(process.env.ITEM_MERGEABLE||'').trim().toUpperCase();",
        "if(!wt){console.log(JSON.stringify({hasConflicts:false,conflictFiles:[]}));process.exit(0);}",
        "const isConflict=reason.includes('merge_conflict')||['CONFLICTING','DIRTY'].includes(mergeable);",
        "if(!isConflict){console.log(JSON.stringify({hasConflicts:false,conflictFiles:[]}));process.exit(0);}",
        "let mergeOutput='';",
        "let conflictFiles=[];",
        "try{",
        "  try{mergeOutput=execFileSync('git',['merge','--no-commit','--no-ff','origin/'+base],{cwd:wt,encoding:'utf8',timeout:60000}).toString();}",
        "  catch(e){mergeOutput=String(e?.stderr||'')+' '+String(e?.stdout||'');}",
        "  try{",
        "    const diffFiles=execFileSync('git',['diff','--name-only','--diff-filter=U'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "    if(diffFiles){conflictFiles=diffFiles.split(/\\r?\\n/).map(f=>f.trim()).filter(Boolean);}",
        "  }catch{}",
        "  if(conflictFiles.length===0){",
        "    const matches=mergeOutput.match(/CONFLICT[^:]*:\\s*Merge conflict in (.+)/gi)||[];",
        "    conflictFiles=matches.map(m=>{const f=m.match(/in\\s+(.+)/i);return f?f[1].trim():'';}).filter(Boolean);",
        "  }",
        "  try{execFileSync('git',['merge','--abort'],{cwd:wt,timeout:10000});}catch{}",
        "}catch(e){",
        "  try{execFileSync('git',['merge','--abort'],{cwd:wt,timeout:10000});}catch{}",
        "  console.log(JSON.stringify({hasConflicts:false,conflictFiles:[],error:String(e?.message||e).slice(0,500)}));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({hasConflicts:conflictFiles.length>0,conflictFiles:[...new Set(conflictFiles)],mergeOutput:String(mergeOutput||'').slice(0,2000)}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      timeoutMs: 120_000,
      env: {
        WORKTREE_PATH:   "{{setup-worktree.output.worktreePath}}",
        PR_BASE:         "{{prParams.base}}",
        ITEM_REASON:     "{{prParams.reason}}",
        ITEM_MERGEABLE:  "{{prParams.mergeable}}",
      },
    }),

    // ── 3. Build rich structured agent prompt from $data.item ────────────────
    node("setup-prompt", "action.set_variable", "Build Agent Prompt", {
      key: "agentPrompt",
      value: "(()=>{\n" +
        "  const item = $data?.item || {};\n" +
        "  const prDigest = item.prDigest || {};\n" +
        "  const core = prDigest.core || {};\n" +
        "  const repo = String(item.repo || core.repo || '');\n" +
        "  const branch = String(item.branch || core.branch || '');\n" +
        "  const base = String(item.base || item.baseBranch || core.baseBranch || 'main');\n" +
        "  const number = String(item.number || item.n || '');\n" +
        "  const title = String(item.title || core.title || '');\n" +
        "  const reason = String(item.reason || '');\n" +
        "  const url = String(item.url || core.url || '');\n" +
        "  const mergeable = String(item.mergeable || core.mergeable || '');\n" +
        "  const failedChecks = Array.isArray(item.failedCheckNames) ? item.failedCheckNames : [];\n" +
        "  const failedJobs = Array.isArray(item.failedJobs) ? item.failedJobs : [];\n" +
        "  const annotations = Array.isArray(item.failedAnnotations) ? item.failedAnnotations : [];\n" +
        "  const logExcerpt = String(item.failedLogExcerpt || '').trim();\n" +
        "  const recentRuns = Array.isArray(item.recentRuns) ? item.recentRuns : [];\n" +
        "  const ciSummary = prDigest.ciSummary || {};\n" +
        "  const prBody = String(core.body || '').trim();\n" +
        "  const files = Array.isArray(prDigest.files) ? prDigest.files : [];\n" +
        "  const reviews = Array.isArray(prDigest.reviews) ? prDigest.reviews : [];\n" +
        "  const reviewComments = Array.isArray(prDigest.reviewComments) ? prDigest.reviewComments : [];\n" +
        "  const issueComments = Array.isArray(prDigest.issueComments) ? prDigest.issueComments : [];\n" +
        "  const allChecks = Array.isArray(prDigest.checks) ? prDigest.checks : [];\n" +
        "  let p = 'You are a Bosun PR repair agent. Your ONLY job is to fix this single PR.\\n\\n';\n" +
        "  p += '## PR Identity\\n\\n';\n" +
        "  p += '- **Repo**: ' + repo + '\\n';\n" +
        "  p += '- **PR Number**: #' + number + '\\n';\n" +
        "  p += '- **Title**: ' + title + '\\n';\n" +
        "  p += '- **URL**: ' + url + '\\n';\n" +
        "  p += '- **Head Branch**: `' + branch + '`\\n';\n" +
        "  p += '- **Base Branch**: `' + base + '`\\n';\n" +
        "  p += '- **Fix Reason**: `' + reason + '`\\n';\n" +
        "  if (mergeable) p += '- **Merge State**: ' + mergeable + '\\n';\n" +
        "  if (item.error) p += '- **Error**: ' + item.error + '\\n';\n" +
        "  if (item.rerunAttempts) p += '- **Rerun Attempts**: ' + item.rerunAttempts + '\\n';\n" +
        "  p += '\\n';\n" +
        "  /* --- Read detected conflict files from detect-conflicts node --- */\n" +
        "  const conflictDetection = (()=>{ try { const o = $ctx?.getNodeOutput?.('detect-conflicts'); if (!o) return {}; const raw = o.output; return typeof raw === 'object' ? raw : JSON.parse(String(raw||'{}')); } catch { return {}; } })();\n" +
        "  const detectedConflictFiles = Array.isArray(conflictDetection?.conflictFiles) ? conflictDetection.conflictFiles : [];\n" +
        "  /* --- Build fix summary (top-line overview like a human reviewer comment) --- */\n" +
        "  const changesRequestedReviews = reviews.filter(r => String(r.state||'').toUpperCase() === 'CHANGES_REQUESTED');\n" +
        "  const actionableInlineComments = reviewComments.filter(c => c.body && c.body.trim());\n" +
        "  const actionableIssueComments = issueComments.filter(c => c.body && /(fix|please|should|must|needs?|issue|bug|error|warning|lint|suggest|change|request|fail|todo|nit|@copilot)/i.test(c.body));\n" +
        "  const fixItems = [];\n" +
        "  if (mergeable === 'CONFLICTING' || mergeable === 'DIRTY' || detectedConflictFiles.length > 0) fixItems.push('**Merge conflicts** — ' + (detectedConflictFiles.length > 0 ? detectedConflictFiles.length + ' files: ' + detectedConflictFiles.map(f => '`' + f + '`').join(', ') : 'resolve all conflicts with base branch `' + base + '`'));\n" +
        "  if (failedChecks.length > 0 || logExcerpt) fixItems.push('**CI/CD failures** — ' + (failedChecks.length > 0 ? failedChecks.length + ' failing checks: ' + failedChecks.map(n => '`' + n + '`').join(', ') : 'see log excerpt below'));\n" +
        "  if (changesRequestedReviews.length > 0 || actionableInlineComments.length > 0 || actionableIssueComments.length > 0) fixItems.push('**Review feedback** — ' + [changesRequestedReviews.length > 0 ? changesRequestedReviews.length + ' change request(s)' : '', actionableInlineComments.length > 0 ? actionableInlineComments.length + ' inline comment(s)' : '', actionableIssueComments.length > 0 ? actionableIssueComments.length + ' issue comment(s)' : ''].filter(Boolean).join(', '));\n" +
        "  if (fixItems.length > 0) {\n" +
        "    p += '## Fix Summary\\n\\n';\n" +
        "    p += 'This PR needs the following fixes:\\n';\n" +
        "    fixItems.forEach((item, i) => { p += (i+1) + '. ' + item + '\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (failedChecks.length > 0) {\n" +
        "    p += '## Failed CI Checks\\n\\n';\n" +
        "    failedChecks.forEach(n => { p += '- `' + n + '`\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (ciSummary.total > 0 || ciSummary.failing > 0) {\n" +
        "    p += '## CI Check Summary\\n\\n';\n" +
        "    p += 'Total: ' + (ciSummary.total||0) + '  |  Failing: ' + (ciSummary.failing||0) + '  |  Pending: ' + (ciSummary.pending||0) + '  |  Passing: ' + (ciSummary.passing||0) + '\\n\\n';\n" +
        "    const failingAllChecks = allChecks.filter(c => ['FAILURE','ERROR','TIMED_OUT','CANCELLED','STARTUP_FAILURE'].includes(c.state));\n" +
        "    if (failingAllChecks.length > 0) {\n" +
        "      p += 'Failing checks:\\n';\n" +
        "      failingAllChecks.forEach(c => { p += '- `' + (c.name||c.workflow||'') + '` → ' + c.state + '\\n'; });\n" +
        "      p += '\\n';\n" +
        "    }\n" +
        "  }\n" +
        "  if (item.failedRun) {\n" +
        "    const run = item.failedRun;\n" +
        "    p += '## Failed Workflow Run\\n\\n';\n" +
        "    p += '- **Workflow**: ' + (run.workflowName || run.displayTitle || '') + '\\n';\n" +
        "    p += '- **Run ID**: ' + run.databaseId + '\\n';\n" +
        "    p += '- **Attempt**: ' + run.attempt + '\\n';\n" +
        "    p += '- **Conclusion**: ' + run.conclusion + '\\n';\n" +
        "    p += '- **URL**: ' + run.url + '\\n';\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (failedJobs.length > 0) {\n" +
        "    p += '## Failed Jobs\\n\\n';\n" +
        "    failedJobs.slice(0,8).forEach(job => {\n" +
        "      p += '### ' + (job.name||'unknown') + '\\n';\n" +
        "      p += '- Conclusion: ' + job.conclusion + '\\n';\n" +
        "      if (job.url) p += '- URL: ' + job.url + '\\n';\n" +
        "      if (Array.isArray(job.failedSteps) && job.failedSteps.length > 0) {\n" +
        "        p += '- Failed steps: ' + job.failedSteps.map(s => '`' + s.name + '`').join(', ') + '\\n';\n" +
        "      }\n" +
        "      p += '\\n';\n" +
        "    });\n" +
        "  }\n" +
        "  if (annotations.length > 0) {\n" +
        "    p += '## Code Annotations (Errors / Warnings)\\n\\n';\n" +
        "    annotations.slice(0,6).forEach(annot => {\n" +
        "      if (Array.isArray(annot.annotations) && annot.annotations.length > 0) {\n" +
        "        p += '**Job: ' + (annot.name||'') + '**\\n';\n" +
        "        annot.annotations.slice(0,15).forEach(a => {\n" +
        "          p += '- `' + (a.path||'') + ':' + (a.startLine||'') + '` **' + (a.title||a.level||'error') + '**: ' + (a.message||'') + '\\n';\n" +
        "        });\n" +
        "        p += '\\n';\n" +
        "      }\n" +
        "    });\n" +
        "  }\n" +
        "  if (logExcerpt) {\n" +
        "    p += '## CI Log Excerpt (Failed Steps)\\n\\n```\\n' + logExcerpt.slice(0,10000) + '\\n```\\n\\n';\n" +
        "  }\n" +
        "  if (recentRuns.length > 0) {\n" +
        "    p += '## Recent CI Runs\\n\\n';\n" +
        "    recentRuns.forEach(r => { p += '- ' + (r.workflowName||r.displayTitle||'') + ' (' + r.conclusion + ') ' + (r.url||'') + '\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (mergeable === 'CONFLICTING' || mergeable === 'DIRTY' || detectedConflictFiles.length > 0) {\n" +
        "    p += '## Merge Conflict\\n\\n';\n" +
        "    p += 'This branch has conflicts that must be resolved.\\n';\n" +
        "    p += 'Merge `origin/' + base + '` into `' + branch + '` and resolve all conflicts.\\n\\n';\n" +
        "    if (detectedConflictFiles.length > 0) {\n" +
        "      p += '**Conflicting files:**\\n';\n" +
        "      detectedConflictFiles.forEach(f => { p += '- `' + f + '`\\n'; });\n" +
        "      p += '\\n';\n" +
        "    }\n" +
        "  }\n" +
        "  if (prBody) {\n" +
        "    p += '## PR Description\\n\\n' + prBody.slice(0,2000) + '\\n\\n';\n" +
        "  }\n" +
        "  if (files.length > 0) {\n" +
        "    p += '## Changed Files (' + files.length + ')\\n\\n';\n" +
        "    files.slice(0,40).forEach(f => { p += '- `' + f.path + '` (+' + (f.additions||0) + '/-' + (f.deletions||0) + ')\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  const reviewsWithBody = reviews.filter(r => r.body && r.body.trim());\n" +
        "  if (reviewsWithBody.length > 0 || reviewComments.length > 0) {\n" +
        "    p += '## Reviews & Inline Comments\\n\\n';\n" +
        "    reviewsWithBody.slice(0,5).forEach(r => {\n" +
        "      p += '**' + (r.author?.login||'reviewer') + '** (' + r.state + '): ' + r.body.slice(0,400) + '\\n\\n';\n" +
        "    });\n" +
        "    if (reviewComments.length > 0) {\n" +
        "      p += 'Inline comments:\\n';\n" +
        "      reviewComments.slice(0,12).forEach(c => {\n" +
        "        p += '- `' + (c.path||'') + ':' + (c.line||'') + '` (' + (c.author?.login||'') + '): ' + (c.body||'').slice(0,250) + '\\n';\n" +
        "      });\n" +
        "      p += '\\n';\n" +
        "    }\n" +
        "  }\n" +
        "  const issueCommentsWithBody = issueComments.filter(c => c.body && c.body.trim());\n" +
        "  if (issueCommentsWithBody.length > 0) {\n" +
        "    p += '## Issue Comments\\n\\n';\n" +
        "    issueCommentsWithBody.slice(0,5).forEach(c => {\n" +
        "      p += '**' + (c.author?.login||'user') + '**: ' + c.body.slice(0,300) + '\\n\\n';\n" +
        "    });\n" +
        "  }\n" +
        "  return p;\n" +
        "})()",
      isExpression: true,
    }),

    // ── 3b. Mark context as agent-workflow-active to prevent delegation ─────
    // Without this flag, action.run_agent delegates to Backend Agent workflow.
    node("mark-active", "action.set_variable", "Mark Agent Workflow Active", {
      key: "_agentWorkflowActive",
      value: "true",
      isExpression: true,
    }),

    // ── 4. Run focused repair agent ──────────────────────────────────────────
    // Agent runs in the pre-cloned worktree on the correct PR branch. It only
    // needs to diagnose, edit code, and commit. No cloning, no branch mgmt.
    node("fix-agent", "action.run_agent", "Fix PR (Dedicated Agent)", {
      prompt:
        "{{agentPrompt}}\n\n" +
        "## Workspace\n\n" +
        "Your working directory is already a git clone of the target repo, checked out " +
        "on the PR's HEAD branch (`{{setup-worktree.output.branch}}`). The base branch " +
        "(`origin/{{setup-worktree.output.base}}`) has been fetched and is available for " +
        "merge/rebase operations.\n\n" +
        "## CRITICAL RULES — READ BEFORE DOING ANYTHING\n\n" +
        "1. **Do NOT clone or re-clone the repo** — you are already in it.\n" +
        "2. **Do NOT create new branches.** Stay on the current branch.\n" +
        "3. **Do NOT push.** The workflow pushes for you automatically after you finish.\n" +
        "4. **Do NOT switch branches** with `git checkout` or `git switch`.\n" +
        "5. **Do NOT run `cd` to change to a different directory.** Stay in the cwd.\n" +
        "6. Fix ONLY the specific issue listed in the Fix Reason above.\n" +
        "7. Do NOT merge, approve, or close the PR.\n" +
        "8. Do NOT touch any other PRs or repos.\n\n" +
        "## Fix Instructions\n\n" +
        "Use prDigest.body, prDigest.files, prDigest.issueComments, prDigest.reviews, " +
        "prDigest.reviewComments, prDigest.checks, failedAnnotations, and any " +
        "failedLogExcerpt before making changes.\n" +
        "Use the PR digest (CI diagnostics, log excerpts, annotations, reviews) " +
        "above to identify the root cause and apply the MINIMAL fix.\n\n" +
        "**By `reason` field:**\n" +
        "- `merge_conflict_requires_code_resolution`: Run `git merge origin/{{setup-worktree.output.base}}`, " +
        "  resolve *all* conflicts in code, run available tests, then `git commit`.\n" +
        "- `auto_rerun_limit_reached` / `ci_rerun_failed`: Study the failed log excerpt and " +
        "  job details to find the root cause. Fix the code, run tests, `git add` and `git commit`.\n" +
        "- `no_rerunnable_failed_run_found`: Look at `gh pr checks` for this PR, inspect the failure, " +
        "  fix the issue, and commit.\n" +
        "- `branch_update_failed` / `missing_repo_or_branch`: Inspect with `gh pr view`, diagnose, fix.\n\n" +
        "**After fixing:** Commit with a clear message like `fix: resolve CI failure in <check_name>`.\n" +
        "Then remove the fix label:\n" +
        "```\n" +
        "gh pr edit {{setup-worktree.output.number}} --repo {{setup-worktree.output.repo}} --remove-label bosun-needs-fix\n" +
        "```\n",
      sdk: "auto",
      timeoutMs: 7_200_000,    // 2 hours — complex fixes need time
      maxRetries: 1,
      retryDelayMs: 60_000,
      sessionRetries: 2,
      maxContinues: 3,
      continueOnSession: true,
      continueOnError: true,
      failOnError: false,
    }),

    // ── 5. Push fixes back to the PR branch ──────────────────────────────────
    // Programmatic push with --force-with-lease ensures the correct branch is
    // updated. Verifies branch name before pushing. Auto-commits uncommitted
    // changes the agent may have left unstaged.
    node("push-fixes", "action.run_command", "Push Fixes to PR Branch", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const wt=String(process.env.WORKTREE_PATH||'').trim();",
        "const branch=String(process.env.PR_BRANCH||'').trim();",
        "const num=String(process.env.PR_NUMBER||'').trim();",
        "const allowPush=!/^(0|false|no|off|disabled)$/i.test(String(process.env.ALLOW_PUSH||'true').trim()||'true');",
        "if(!wt||!branch){console.log(JSON.stringify({pushed:false,reason:'missing_worktree_or_branch'}));process.exit(0);}",
        "if(!allowPush){console.log(JSON.stringify({pushed:false,reason:'push_disabled'}));process.exit(0);}",
        // Verify we are on the correct branch
        "const cur=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "if(cur!==branch){console.log(JSON.stringify({pushed:false,reason:'wrong_branch',expected:branch,actual:cur}));process.exit(1);}",
        // Stage and commit any uncommitted changes the agent left behind
        "const status=execFileSync('git',['status','--porcelain'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "if(status){",
        "  execFileSync('git',['add','-A'],{cwd:wt,encoding:'utf8',timeout:30000});",
        "  try{execFileSync('git',['commit','-m','bosun: commit remaining changes for PR #'+num],{cwd:wt,encoding:'utf8',timeout:30000});}catch{}",
        "}",
        // Check if there are commits to push vs origin
        "let hasDiff=false;",
        "try{const d=execFileSync('git',['rev-list','--count','origin/'+branch+'..HEAD'],{cwd:wt,encoding:'utf8',timeout:30000}).trim();hasDiff=Number(d)>0;}",
        "catch{hasDiff=true;}",  // if origin/<branch> doesn't exist, assume diff
        "if(!hasDiff){console.log(JSON.stringify({pushed:false,reason:'no_new_commits'}));process.exit(0);}",
        // Push with safety
        "execFileSync('git',['push','--force-with-lease','origin','HEAD:'+branch],{cwd:wt,encoding:'utf8',timeout:120000,stdio:'inherit'});",
        "console.log(JSON.stringify({pushed:true,branch:cur,commits:Number(execFileSync('git',['rev-list','--count','origin/'+branch+'..HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim()||0)}));",
      ].join(" ")],
      parseJson: true,
      continueOnError: true,
      failOnError: false,
      timeoutMs: 300_000,
      env: {
        WORKTREE_PATH: "{{setup-worktree.output.worktreePath}}",
        PR_BRANCH:     "{{setup-worktree.output.branch}}",
        PR_NUMBER:     "{{setup-worktree.output.number}}",
        ALLOW_PUSH:    "{{allowPush}}",
      },
    }),

    // ── 6. Clean up the temp worktree ────────────────────────────────────────
    node("cleanup-worktree", "action.run_command", "Cleanup Temp Worktree", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const {resolve}=require('path');",
        "const {tmpdir}=require('os');",
        "const wt=String(process.env.WORKTREE_PATH||'').trim();",
        "if(!wt){console.log(JSON.stringify({cleaned:false,reason:'no_path'}));process.exit(0);}",
        "const target=resolve(wt);",
        "const tempRoot=resolve(tmpdir());",
        "if(!target.toLowerCase().startsWith(tempRoot.toLowerCase())){console.log(JSON.stringify({cleaned:false,reason:'outside_temp_root',path:target,tempRoot}));process.exit(0);}",
        "let lastError=null;",
        "for(let attempt=1;attempt<=8;attempt++){",
        "  try{fs.rmSync(target,{recursive:true,force:true,maxRetries:3,retryDelay:250});console.log(JSON.stringify({cleaned:true,path:target,attempt}));process.exit(0);}",
        "  catch(e){lastError=e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250*attempt);}",
        "}",
        "console.log(JSON.stringify({cleaned:false,error:String(lastError?.message||lastError),path:target}));",
      ].join(" ")],
      parseJson: true,
      continueOnError: true,
      failOnError: false,
      env: {
        WORKTREE_PATH: "{{setup-worktree.output.worktreePath}}",
      },
    }),

    // ── 6b. Update sibling PR branches (keep other PRs up-to-date after fix push) ─
    node("update-sibling-branches", "action.run_command", "Update Sibling PR Branches", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const repo=String(process.env.REPO||'').trim();",
        "const thisPrNumber=String(process.env.THIS_PR||'').trim();",
        "const base=String(process.env.BASE_BRANCH||'main').trim();",
        "const allowPush=!/^(0|false|no|off|disabled)$/i.test(String(process.env.ALLOW_PUSH||'true').trim()||'true');",
        "if(!repo){console.log(JSON.stringify({updated:0,reason:'no repo'}));process.exit(0);}",
        "if(!allowPush){console.log(JSON.stringify({updated:0,reason:'push_disabled'}));process.exit(0);}",
        "let prs=[];",
        "try{prs=JSON.parse(execFileSync('gh',['pr','list','--repo',repo,'--base',base,'--state','open','--json','number,headRefOid','--limit','50'],{encoding:'utf8',timeout:30000}));}",
        "catch(e){console.log(JSON.stringify({updated:0,error:String(e?.message||e).slice(0,200)}));process.exit(0);}",
        "let updated=0,failed=0;",
        "for(const pr of prs){",
        "  if(String(pr.number)===thisPrNumber)continue;",
        "  try{",
        "    execFileSync('gh',['api','-X','PUT','repos/'+repo+'/pulls/'+pr.number+'/update-branch','--field','expected_head_sha='+pr.headRefOid],{encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30000});",
        "    updated++;console.log('Updated PR #'+pr.number);",
        "  }catch(e){",
        "    const msg=String(e?.stderr||e?.message||e);",
        "    if(/already up/i.test(msg)||/merge conflict/i.test(msg)){continue;}",
        "    failed++;console.log('Skip PR #'+pr.number+': '+msg.slice(0,150));",
        "  }",
        "}",
        "console.log(JSON.stringify({updated,failed,total:prs.length}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      timeoutMs: 180_000,
      env: {
        REPO: "{{prParams.repo}}",
        THIS_PR: "{{prParams.number}}",
        BASE_BRANCH: "{{prParams.base}}",
        ALLOW_PUSH: "{{allowPush}}",
      },
    }),

    // ── 7. Release the PR claim ──────────────────────────────────────────────
    node("release-claim", "action.run_command", "Release PR Claim", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const claimKey=String(process.env.PR_CLAIM_KEY||'').trim();",
        "if(!claimKey){console.log(JSON.stringify({released:false,reason:'no_claim_key'}));process.exit(0);}",
        "const CLAIM_FILE=path.join(process.cwd(),'.cache','bosun','pr-fix-claims.json');",
        "try{",
        "  if(!fs.existsSync(CLAIM_FILE)){console.log(JSON.stringify({released:false,reason:'no_claim_file'}));process.exit(0);}",
        "  const data=JSON.parse(fs.readFileSync(CLAIM_FILE,'utf8'));",
        "  if(data.claims&&data.claims[claimKey]){",
        "    delete data.claims[claimKey];",
        "    data.updatedAt=new Date().toISOString();",
        "    fs.writeFileSync(CLAIM_FILE,JSON.stringify(data,null,2),'utf8');",
        "    console.log(JSON.stringify({released:true,claimKey}));",
        "  }else{",
        "    console.log(JSON.stringify({released:false,reason:'not_found',claimKey}));",
        "  }",
        "}catch(e){",
        "  console.log(JSON.stringify({released:false,reason:'error',error:String(e?.message||e),claimKey}));",
        "}",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        PR_CLAIM_KEY: "{{claimKey}}",
      },
    }),
  ],
  edges: [
    edge("trigger",            "setup-task"),
    edge("setup-task",         "setup-title"),
    edge("setup-title",        "setup-claim-key"),
    edge("setup-claim-key",    "resolve-pr-params"),
    edge("resolve-pr-params",  "validate-pr-state"),
    edge("validate-pr-state",  "setup-worktree", { condition: "($output?.output?.open ?? $output?.open) === true" }),
    edge("validate-pr-state",  "resolve-pr-task", { condition: "($output?.output?.open ?? $output?.open) !== true && ($output?.output?.shouldResolveTask ?? $output?.shouldResolveTask) === true" }),
    edge("validate-pr-state",  "release-claim", { condition: "($output?.output?.open ?? $output?.open) !== true && ($output?.output?.shouldResolveTask ?? $output?.shouldResolveTask) !== true" }),
    edge("setup-worktree",     "resolve-pr-task", { condition: "($output?.output?.skip ?? $output?.skip) === true && ($output?.output?.shouldResolveTask ?? $output?.shouldResolveTask) === true" }),
    edge("setup-worktree",     "set-worktree-path", { condition: "($output?.output?.skip ?? $output?.skip) !== true" }),
    edge("set-worktree-path",  "detect-conflicts"),
    edge("detect-conflicts",   "setup-prompt"),
    edge("setup-prompt",       "mark-active"),
    edge("mark-active",        "fix-agent"),
    edge("fix-agent",          "push-fixes"),
    edge("push-fixes",         "cleanup-worktree"),
    edge("cleanup-worktree",   "update-sibling-branches"),
    edge("resolve-pr-task",    "release-claim"),
    edge("update-sibling-branches", "release-claim"),
  ],
  metadata: {
    author: "bosun",
    version: 8,
    createdAt: "2026-03-30T00:00:00Z",
    templateVersion: "7.0.0",
    tags: ["github", "pr", "ci", "fix", "single-pr", "session-tracked", "worktree-managed"],
    notes:
      "Invoked by template-bosun-pr-watchdog via loop.for_each. " +
      "Do not enable this template as a standalone scheduled workflow. " +
      "v3.0: Adds detect-conflicts node for specific conflict file discovery, " +
      "fix summary section with actionable items, and enhanced review signal extraction. " +
      "v2.0: Programmatic worktree setup + push. Agent no longer manages " +
      "git clone/push — prevents wrong-branch pushes and new-branch creation.",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  PR Security Fix Agent (Single PR)
//  Per-PR workflow dispatched by the Watchdog for security/CodeQL failures.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_SECURITY_FIX_SINGLE_TEMPLATE = {
  id: "template-pr-security-fix-single",
  name: "PR Security Fix Agent (Single PR)",
  description:
    "Fixes one Bosun-attached PR with CodeQL or code-scanning failures " +
    "using a dedicated long-running agent (up to 2 hours). " +
    "Programmatically clones the target repo and checks out the PR's HEAD branch " +
    "into a temp worktree, runs the agent there, then pushes fixes back with " +
    "--force-with-lease. The agent NEVER manages git setup or push.",
  category: "github",
  enabled: true,
  recommended: true,
  core: true,
  trigger: "trigger.manual",
  variables: {},
  nodes: [
    node("trigger", "trigger.manual", "Start"),

    node("setup-task", "action.set_variable", "Setup Security PR Task ID", {
      key: "taskId",
      value:
        "'pr-secfix-' + " +
        "String($data?.item?.taskId || " +
        "  (String($data?.item?.repo || '').replace(/[^a-z0-9]/gi, '-').replace(/-+/g,'-').replace(/^-|-$/g,'') + " +
        "   '-' + String($data?.item?.number || $data?.item?.n || '0'))).replace(/^-|-$/g, '')",
      isExpression: true,
    }),

    node("setup-title", "action.set_variable", "Setup Security PR Task Title", {
      key: "taskTitle",
      value:
        "'Security Fix PR #' + String($data?.item?.number || $data?.item?.n || '?') + " +
        "' (' + String($data?.item?.repo || '') + ')'",
      isExpression: true,
    }),

    node("setup-claim-key", "action.set_variable", "Setup Claim Key", {
      key: "claimKey",
      value: "String($data?.item?.claimKey || '')",
      isExpression: true,
    }),

    // ── Pre-resolve PR parameters with full fallback chains ──────────────────
    node("resolve-pr-params", "action.set_variable", "Resolve PR Parameters", {
      key: "prParams",
      value:
        "({" +
        "repo: String($data?.item?.repo || $data?.item?.prDigest?.core?.repo || ''), " +
        "branch: String($data?.item?.prDigest?.core?.branch || $data?.item?.branch || ''), " +
        "base: String($data?.item?.base || $data?.item?.baseBranch || $data?.item?.prDigest?.core?.baseBranch || 'main'), " +
        "number: String($data?.item?.number || $data?.item?.n || '0')" +
        "})",
      isExpression: true,
    }),

    node("validate-pr-state", "action.run_command", "Validate PR Is Still Open", {
      command: "node",
      args: ["-e", makeValidatePrStateScript().join(" ")],
      parseJson: true,
      continueOnError: true,
      failOnError: false,
      timeoutMs: 60_000,
      env: {
        PR_REPO:   "{{prParams.repo}}",
        PR_BRANCH: "{{prParams.branch}}",
        PR_BASE:   "{{prParams.base}}",
        PR_NUMBER: "{{prParams.number}}",
      },
    }),

    node("resolve-pr-task", "action.run_command", "Resolve Task For Closed or Merged PR", {
      command: "node",
      args: ["-e", makeResolvePrTaskScript().join(" ")],
      parseJson: true,
      continueOnError: true,
      failOnError: false,
      timeoutMs: 60_000,
      env: {
        TASK_ID: "{{taskId}}",
        PR_REPO: "{{$ctx.getNodeOutput('setup-worktree')?.output?.repo || $ctx.getNodeOutput('validate-pr-state')?.output?.repo || $data?.prParams?.repo || ''}}",
        PR_NUMBER: "{{$ctx.getNodeOutput('setup-worktree')?.output?.number || $ctx.getNodeOutput('validate-pr-state')?.output?.number || $data?.prParams?.number || ''}}",
        PR_BRANCH: "{{$ctx.getNodeOutput('setup-worktree')?.output?.branch || $ctx.getNodeOutput('validate-pr-state')?.output?.branch || $data?.prParams?.branch || ''}}",
        PR_URL: "{{$ctx.getNodeOutput('setup-worktree')?.output?.url || $ctx.getNodeOutput('validate-pr-state')?.output?.url || $data?.item?.url || $data?.item?.prDigest?.core?.url || ''}}",
        PR_STATE: "{{$ctx.getNodeOutput('setup-worktree')?.output?.state || $ctx.getNodeOutput('validate-pr-state')?.output?.state || ''}}",
        PR_MERGED_AT: "{{$ctx.getNodeOutput('setup-worktree')?.output?.mergedAt || $ctx.getNodeOutput('validate-pr-state')?.output?.mergedAt || ''}}",
        PR_CLOSED_AT: "{{$ctx.getNodeOutput('setup-worktree')?.output?.closedAt || $ctx.getNodeOutput('validate-pr-state')?.output?.closedAt || ''}}",
        TARGET_TASK_STATUS: "{{$ctx.getNodeOutput('setup-worktree')?.output?.targetTaskStatus || $ctx.getNodeOutput('validate-pr-state')?.output?.targetTaskStatus || ''}}",
        PR_REASON: "{{$ctx.getNodeOutput('setup-worktree')?.output?.reason || $ctx.getNodeOutput('validate-pr-state')?.output?.reason || ''}}",
      },
    }),

    // ── Programmatic worktree setup ──────────────────────────────────────────
    node("setup-worktree", "action.run_command", "Clone & Checkout PR Branch", {
      command: "node",
      args: ["-e", makeSetupWorktreeScript("bosun-secfix").join(" ")],
      parseJson: true,
      failOnError: true,
      timeoutMs: 600_000,
      env: {
        PR_REPO:   "{{$ctx.getNodeOutput('validate-pr-state')?.output?.repo || $data?.prParams?.repo || ''}}",
        PR_BRANCH: "{{$ctx.getNodeOutput('validate-pr-state')?.output?.branch || $data?.prParams?.branch || ''}}",
        PR_BASE:   "{{$ctx.getNodeOutput('validate-pr-state')?.output?.base || $data?.prParams?.base || ''}}",
        PR_NUMBER: "{{$ctx.getNodeOutput('validate-pr-state')?.output?.number || $data?.prParams?.number || ''}}",
      },
    }),

    node("set-worktree-path", "action.set_variable", "Set Agent Working Directory", {
      key: "worktreePath",
      value: "{{setup-worktree.output.worktreePath}}",
    }),

    node("setup-prompt", "action.set_variable", "Build Security Agent Prompt", {
      key: "agentPrompt",
      value: "(()=>{\n" +
        "  const item = $data?.item || {};\n" +
        "  const prDigest = item.prDigest || {};\n" +
        "  const core = prDigest.core || {};\n" +
        "  const repo = String(item.repo || core.repo || '');\n" +
        "  const branch = String(item.branch || core.branch || '');\n" +
        "  const base = String(item.base || item.baseBranch || core.baseBranch || 'main');\n" +
        "  const number = String(item.number || item.n || '');\n" +
        "  const title = String(item.title || core.title || '');\n" +
        "  const url = String(item.url || core.url || '');\n" +
        "  const securityChecks = Array.isArray(item.securityCheckNames) ? item.securityCheckNames : [];\n" +
        "  const failedChecks = Array.isArray(item.failedCheckNames) ? item.failedCheckNames : [];\n" +
        "  const alerts = Array.isArray(item.alerts) ? item.alerts : [];\n" +
        "  const fetchError = String(item.fetchError || '').trim();\n" +
        "  const prBody = String(core.body || '').trim();\n" +
        "  const files = Array.isArray(prDigest.files) ? prDigest.files : [];\n" +
        "  const reviews = Array.isArray(prDigest.reviews) ? prDigest.reviews : [];\n" +
        "  const reviewComments = Array.isArray(prDigest.reviewComments) ? prDigest.reviewComments : [];\n" +
        "  const allChecks = Array.isArray(prDigest.checks) ? prDigest.checks : [];\n" +
        "  let p = 'You are a Bosun PR **security remediation** agent. Fix ONLY the security/CodeQL findings on this single PR.\\n\\n';\n" +
        "  p += '## PR Identity\\n\\n';\n" +
        "  p += '- **Repo**: ' + repo + '\\n';\n" +
        "  p += '- **PR Number**: #' + number + '\\n';\n" +
        "  p += '- **Title**: ' + title + '\\n';\n" +
        "  p += '- **URL**: ' + url + '\\n';\n" +
        "  p += '- **Head Branch**: `' + branch + '`\\n';\n" +
        "  p += '- **Base Branch**: `' + base + '`\\n\\n';\n" +
        "  if (securityChecks.length > 0) {\n" +
        "    p += '## Failed Security Checks\\n\\n';\n" +
        "    securityChecks.forEach(n => { p += '- `' + n + '`\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  if (alerts.length > 0) {\n" +
        "    p += '## Code Scanning Alerts\\n\\n';\n" +
        "    alerts.forEach(a => {\n" +
        "      p += '### Alert #' + (a.number||'?') + ' — ' + (a.ruleName||a.ruleId||'unknown rule') + '\\n';\n" +
        "      p += '- **Severity**: ' + (a.securitySeverity||a.severity||'unknown') + '\\n';\n" +
        "      p += '- **Tool**: ' + (a.tool||'unknown') + '\\n';\n" +
        "      p += '- **File**: `' + (a.path||'') + ':' + (a.startLine||'') + '`\\n';\n" +
        "      if (a.url) p += '- **URL**: ' + a.url + '\\n';\n" +
        "      p += '\\n';\n" +
        "    });\n" +
        "  }\n" +
        "  if (fetchError) {\n" +
        "    p += '## Alert Fetch Error\\n\\n' + fetchError + '\\n\\n';\n" +
        "    p += 'Alert fetch failed. Inspect the PR checks and source code directly to identify the security issue.\\n\\n';\n" +
        "  }\n" +
        "  if (prBody) {\n" +
        "    p += '## PR Description\\n\\n' + prBody.slice(0,2000) + '\\n\\n';\n" +
        "  }\n" +
        "  if (files.length > 0) {\n" +
        "    p += '## Changed Files (' + files.length + ')\\n\\n';\n" +
        "    files.slice(0,40).forEach(f => { p += '- `' + f.path + '` (+' + (f.additions||0) + '/-' + (f.deletions||0) + ')\\n'; });\n" +
        "    p += '\\n';\n" +
        "  }\n" +
        "  return p;\n" +
        "})()",
      isExpression: true,
    }),

    node("mark-active", "action.set_variable", "Mark Agent Workflow Active", {
      key: "_agentWorkflowActive",
      value: "true",
      isExpression: true,
    }),

    node("fix-agent", "action.run_agent", "Fix Security Issue (Dedicated Agent)", {
      prompt:
        "{{agentPrompt}}\n\n" +
        "## Workspace\n\n" +
        "Your working directory is already a git clone of the target repo, checked out " +
        "on the PR's HEAD branch (`{{setup-worktree.output.branch}}`). The base branch " +
        "(`origin/{{setup-worktree.output.base}}`) has been fetched.\n\n" +
        "## CRITICAL RULES — READ BEFORE DOING ANYTHING\n\n" +
        "1. **Do NOT clone or re-clone the repo** — you are already in it.\n" +
        "2. **Do NOT create new branches.** Stay on the current branch.\n" +
        "3. **Do NOT push.** The workflow pushes for you automatically after you finish.\n" +
        "4. **Do NOT switch branches** with `git checkout` or `git switch`.\n" +
        "5. **Do NOT run `cd` to change to a different directory.** Stay in the cwd.\n" +
        "6. Fix ONLY the listed security/CodeQL findings. No unrelated changes.\n" +
        "7. Do NOT merge, approve, or close the PR.\n" +
        "8. Do NOT touch any other PRs or repos.\n\n" +
        "## Fix Instructions\n\n" +
        "1. Read each alert's file and line number from the context above.\n" +
        "2. Understand the security finding (SQL injection, XSS, path traversal, etc.).\n" +
        "3. Apply the MINIMAL code change that resolves the finding.\n" +
        "4. If alerts could not be fetched, run:\n" +
        "   `gh api repos/{{setup-worktree.output.repo}}/code-scanning/alerts " +
        "--jq '.[] | select(.state==\"open\")' -X GET`\n" +
        "5. Run any available tests to validate the fix.\n" +
        "6. `git add` and `git commit` with a clear message referencing the security finding.\n\n" +
        "**After fixing:** Remove the fix label:\n" +
        "```\n" +
        "gh pr edit {{setup-worktree.output.number}} --repo {{setup-worktree.output.repo}} --remove-label bosun-needs-fix\n" +
        "```\n",
      sdk: "auto",
      timeoutMs: 7_200_000,
      maxRetries: 1,
      retryDelayMs: 60_000,
      sessionRetries: 2,
      maxContinues: 3,
      continueOnSession: true,
      continueOnError: true,
      failOnError: false,
    }),

    // ── Push fixes back to the PR branch ─────────────────────────────────────
    node("push-fixes", "action.run_command", "Push Fixes to PR Branch", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const wt=String(process.env.WORKTREE_PATH||'').trim();",
        "const branch=String(process.env.PR_BRANCH||'').trim();",
        "const num=String(process.env.PR_NUMBER||'').trim();",
        "const allowPush=!/^(0|false|no|off|disabled)$/i.test(String(process.env.ALLOW_PUSH||'true').trim()||'true');",
        "if(!wt||!branch){console.log(JSON.stringify({pushed:false,reason:'missing_worktree_or_branch'}));process.exit(0);}",
        "if(!allowPush){console.log(JSON.stringify({pushed:false,reason:'push_disabled'}));process.exit(0);}",
        "const cur=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "if(cur!==branch){console.log(JSON.stringify({pushed:false,reason:'wrong_branch',expected:branch,actual:cur}));process.exit(1);}",
        "const status=execFileSync('git',['status','--porcelain'],{cwd:wt,encoding:'utf8',timeout:10000}).trim();",
        "if(status){",
        "  execFileSync('git',['add','-A'],{cwd:wt,encoding:'utf8',timeout:30000});",
        "  try{execFileSync('git',['commit','-m','bosun: commit security fix changes for PR #'+num],{cwd:wt,encoding:'utf8',timeout:30000});}catch{}",
        "}",
        "let hasDiff=false;",
        "try{const d=execFileSync('git',['rev-list','--count','origin/'+branch+'..HEAD'],{cwd:wt,encoding:'utf8',timeout:30000}).trim();hasDiff=Number(d)>0;}",
        "catch{hasDiff=true;}",
        "if(!hasDiff){console.log(JSON.stringify({pushed:false,reason:'no_new_commits'}));process.exit(0);}",
        "execFileSync('git',['push','--force-with-lease','origin','HEAD:'+branch],{cwd:wt,encoding:'utf8',timeout:120000,stdio:'inherit'});",
        "console.log(JSON.stringify({pushed:true,branch:cur}));",
      ].join(" ")],
      parseJson: true,
      continueOnError: true,
      failOnError: false,
      timeoutMs: 300_000,
      env: {
        WORKTREE_PATH: "{{setup-worktree.output.worktreePath}}",
        PR_BRANCH:     "{{setup-worktree.output.branch}}",
        PR_NUMBER:     "{{setup-worktree.output.number}}",
        ALLOW_PUSH:    "{{allowPush}}",
      },
    }),

    // ── Clean up temp worktree ───────────────────────────────────────────────
    node("cleanup-worktree", "action.run_command", "Cleanup Temp Worktree", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const {resolve}=require('path');",
        "const {tmpdir}=require('os');",
        "const wt=String(process.env.WORKTREE_PATH||'').trim();",
        "if(!wt){console.log(JSON.stringify({cleaned:false,reason:'no_path'}));process.exit(0);}",
        "const target=resolve(wt);",
        "const tempRoot=resolve(tmpdir());",
        "if(!target.toLowerCase().startsWith(tempRoot.toLowerCase())){console.log(JSON.stringify({cleaned:false,reason:'outside_temp_root',path:target,tempRoot}));process.exit(0);}",
        "let lastError=null;",
        "for(let attempt=1;attempt<=8;attempt++){",
        "  try{fs.rmSync(target,{recursive:true,force:true,maxRetries:3,retryDelay:250});console.log(JSON.stringify({cleaned:true,path:target,attempt}));process.exit(0);}",
        "  catch(e){lastError=e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250*attempt);}",
        "}",
        "console.log(JSON.stringify({cleaned:false,error:String(lastError?.message||lastError),path:target}));",
      ].join(" ")],
      parseJson: true,
      continueOnError: true,
      failOnError: false,
      env: {
        WORKTREE_PATH: "{{setup-worktree.output.worktreePath}}",
      },
    }),

    // ── Release the PR claim ─────────────────────────────────────────────────
    node("release-claim", "action.run_command", "Release Security PR Claim", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const claimKey=String(process.env.PR_CLAIM_KEY||'').trim();",
        "if(!claimKey){console.log(JSON.stringify({released:false,reason:'no_claim_key'}));process.exit(0);}",
        "const CLAIM_FILE=path.join(process.cwd(),'.cache','bosun','pr-security-fix-claims.json');",
        "try{",
        "  if(!fs.existsSync(CLAIM_FILE)){console.log(JSON.stringify({released:false,reason:'no_claim_file'}));process.exit(0);}",
        "  const data=JSON.parse(fs.readFileSync(CLAIM_FILE,'utf8'));",
        "  if(data.claims&&data.claims[claimKey]){",
        "    delete data.claims[claimKey];",
        "    data.updatedAt=new Date().toISOString();",
        "    fs.writeFileSync(CLAIM_FILE,JSON.stringify(data,null,2),'utf8');",
        "    console.log(JSON.stringify({released:true,claimKey}));",
        "  }else{",
        "    console.log(JSON.stringify({released:false,reason:'not_found',claimKey}));",
        "  }",
        "}catch(e){",
        "  console.log(JSON.stringify({released:false,reason:'error',error:String(e?.message||e),claimKey}));",
        "}",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        PR_CLAIM_KEY: "{{claimKey}}",
      },
    }),
  ],
  edges: [
    edge("trigger",            "setup-task"),
    edge("setup-task",         "setup-title"),
    edge("setup-title",        "setup-claim-key"),
    edge("setup-claim-key",    "resolve-pr-params"),
    edge("resolve-pr-params",  "validate-pr-state"),
    edge("validate-pr-state",  "setup-worktree", { condition: "($output?.output?.open ?? $output?.open) === true" }),
    edge("validate-pr-state",  "resolve-pr-task", { condition: "($output?.output?.open ?? $output?.open) !== true && ($output?.output?.shouldResolveTask ?? $output?.shouldResolveTask) === true" }),
    edge("validate-pr-state",  "release-claim", { condition: "($output?.output?.open ?? $output?.open) !== true && ($output?.output?.shouldResolveTask ?? $output?.shouldResolveTask) !== true" }),
    edge("setup-worktree",     "resolve-pr-task", { condition: "($output?.output?.skip ?? $output?.skip) === true && ($output?.output?.shouldResolveTask ?? $output?.shouldResolveTask) === true" }),
    edge("setup-worktree",     "set-worktree-path", { condition: "($output?.output?.skip ?? $output?.skip) !== true" }),
    edge("set-worktree-path",  "setup-prompt"),
    edge("setup-prompt",       "mark-active"),
    edge("mark-active",        "fix-agent"),
    edge("fix-agent",          "push-fixes"),
    edge("push-fixes",         "cleanup-worktree"),
    edge("resolve-pr-task",    "release-claim"),
    edge("cleanup-worktree",   "release-claim"),
  ],
  metadata: {
    author: "bosun",
    version: 5,
    createdAt: "2026-03-30T00:00:00Z",
    templateVersion: "5.0.0",
    tags: ["github", "pr", "security", "codeql", "fix", "single-pr", "session-tracked", "worktree-managed"],
    notes:
      "Invoked by template-bosun-pr-watchdog via loop.for_each for security failures. " +
      "Do not enable as standalone. v2.0: Programmatic worktree + push.",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  GitHub ↔ Kanban Sync
//  Replaces github-reconciler.mjs — reconciles PR state with kanban board.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const GITHUB_KANBAN_SYNC_TEMPLATE = {
  id: "template-github-kanban-sync",
  name: "GitHub ↔ Kanban Sync",
  description:
    "Reconciles GitHub PR state with the bosun kanban board every 5 minutes. " +
    "Marks tasks as in-review when Bosun-created PRs open, moves them to done " +
    "when PRs are merged, and posts completion comments via the kanban API. " +
    "Replaces the legacy github-reconciler.mjs module.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    lookbackHours: 24,
    repoScope: "auto",
  },
  nodes: [
    node("trigger", "trigger.schedule", "Sync Every 5 min", {
      intervalMs: 300_000,
      cron: "*/5 * * * *",
    }, { x: 400, y: 50 }),

    node("fetch-pr-state", "action.run_command", "Fetch Bosun PR State", {
      command: "node",
      args: ["-e", [
        "const fs=require('fs');",
        "const path=require('path');",
        "const {execFileSync}=require('child_process');",
        "const hours=Number('{{lookbackHours}}')||24;",
        "const repoScope=String('{{repoScope}}'||'auto').trim();",
        "const since=new Date(Date.now()-hours*3600000).toISOString();",
        "function ghJson(args){",
        "  try{const o=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();return o?JSON.parse(o):[];}",
        "  catch{return [];}",
        "}",
        "function configPath(){",
        "  const home=String(process.env.BOSUN_HOME||process.env.BOSUN_PROJECT_DIR||'').trim();",
        "  return home?path.join(home,'bosun.config.json'):path.join(process.cwd(),'bosun.config.json');",
        "}",
        "function collectReposFromConfig(){",
        "  const repos=[];",
        "  try{",
        "    const cfg=JSON.parse(fs.readFileSync(configPath(),'utf8'));",
        "    const workspaces=Array.isArray(cfg?.workspaces)?cfg.workspaces:[];",
        "    if(workspaces.length>0){",
        "      const active=String(cfg?.activeWorkspace||'').trim().toLowerCase();",
        "      const activeWs=active?workspaces.find(w=>String(w?.id||'').trim().toLowerCase()===active):null;",
        "      const wsList=activeWs?[activeWs]:workspaces;",
        "      for(const ws of wsList){",
        "        for(const repo of (Array.isArray(ws?.repos)?ws.repos:[])){",
        "          const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();",
        "          if(slug) repos.push(slug);",
        "        }",
        "      }",
        "    }",
        "    if(repos.length===0){",
        "      for(const repo of (Array.isArray(cfg?.repos)?cfg.repos:[])){",
        "        const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();",
        "        if(slug) repos.push(slug);",
        "      }",
        "    }",
        "  }catch{}",
        "  return repos;",
        "}",
        "function resolveRepoTargets(){",
        "  if(repoScope&&repoScope!=='auto'&&repoScope!=='all'&&repoScope!=='current'){",
        "    return [...new Set(repoScope.split(',').map(v=>v.trim()).filter(Boolean))];",
        "  }",
        "  if(repoScope==='current') return [''];",
        "  const fromConfig=collectReposFromConfig();",
        "  if(fromConfig.length>0) return [...new Set(fromConfig)];",
        "  const envRepo=String(process.env.GITHUB_REPOSITORY||'').trim();",
        "  if(envRepo) return [envRepo];",
        "  return [''];",
        "}",
        "function parseRepoFromUrl(url){",
        "  const raw=String(url||'');",
        "  const marker='github.com/';",
        "  const idx=raw.toLowerCase().indexOf(marker);",
        "  if(idx<0) return '';",
        "  const tail=raw.slice(idx+marker.length).split('/');",
        "  if(tail.length<2) return '';",
        "  const owner=String(tail[0]||'').trim();",
        "  const repo=String(tail[1]||'').trim();",
        "  return owner&&repo?(owner+'/'+repo):'';",
        "}",
        "function extractTaskId(pr){",
        "  const src=String((pr.body||'')+'\\n'+(pr.title||''));",
        "  const m=src.match(/(?:Bosun-Task|VE-Task|Task-ID|task[_-]?id)[:\\s]+([a-zA-Z0-9_-]{4,64})/i);",
        "  return m?m[1].trim():null;",
        "}",
        "function shouldSyncTaskPr(pr){ return Boolean(extractTaskId(pr)); }",
        "const repoTargets=resolveRepoTargets();",
        "const merged=[];",
        "const open=[];",
        "for(const target of repoTargets){",
        "  const repo=String(target||'').trim();",
        "  const mergedArgs=['pr','list','--state','merged','--json','number,title,body,headRefName,mergedAt,url','--limit','50'];",
        "  const openArgs=['pr','list','--state','open','--json','number,title,body,headRefName,isDraft,url','--limit','50'];",
        "  if(repo){ mergedArgs.push('--repo',repo); openArgs.push('--repo',repo); }",
        "  for(const pr of ghJson(mergedArgs)){ if(shouldSyncTaskPr(pr)) merged.push({...pr,__repo:repo||parseRepoFromUrl(pr?.url)||String(process.env.GITHUB_REPOSITORY||'').trim()}); }",
        "  for(const pr of ghJson(openArgs)){ if(shouldSyncTaskPr(pr)) open.push({...pr,__repo:repo||parseRepoFromUrl(pr?.url)||String(process.env.GITHUB_REPOSITORY||'').trim()}); }",
        "}",
        "const recentMerged=merged.filter(p=>!p.mergedAt||new Date(p.mergedAt)>=new Date(since));",
        "console.log(JSON.stringify({",
        "  repoScope,",
        "  reposScanned: repoTargets.length,",
        "  merged:recentMerged.map(p=>({n:p.number,repo:p.__repo||'',title:p.title,branch:p.headRefName,taskId:extractTaskId(p)})),",
        "  open:open.filter(p=>!p.isDraft).map(p=>({n:p.number,repo:p.__repo||'',title:p.title,branch:p.headRefName,taskId:extractTaskId(p)})),",
        "}));",
      ].join(" ")],
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("has-updates", "condition.expression", "Any Updates?", {
      expression:
        "(()=>{try{" +
        "const o=$ctx.getNodeOutput('fetch-pr-state')?.output;" +
        "const d=JSON.parse(o||'{}');" +
        "return (d.merged||[]).length>0||(d.open||[]).length>0;" +
        "}catch{return false;}})()",
    }, { x: 400, y: 370 }),

    node("sync-programmatic", "action.run_command", "Sync PR State → Kanban (Programmatic)", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const fs=require('fs');",
        "const raw=String(process.env.BOSUN_FETCH_PR_STATE||'');",
        "const data=(()=>{try{return JSON.parse(raw||'{}')}catch{return {}}})();",
        "const merged=Array.isArray(data.merged)?data.merged:[];",
        "const open=Array.isArray(data.open)?data.open:[];",
        "const updates=[]; const unresolved=[];",
        "const maxBuffer=25*1024*1024;",
        "const cliPath=fs.existsSync('cli.mjs')?'cli.mjs':'';",
        "const taskCli=['task/task-cli.mjs','task-cli.mjs'].find(p=>fs.existsSync(p))||'';",
        "const taskRunner=cliPath?'cli':(taskCli?'task-cli':'');",
        "if(!taskRunner){",
        "  console.log(JSON.stringify({updated:0,unresolved:[{reason:'task_command_missing'}],needsAgent:true}));",
        "  process.exit(0);",
        "}",
        "function runTask(args){const cmdArgs=taskRunner==='cli'?['cli.mjs','task',...args,'--config-dir','.bosun','--repo-root','.']:[taskCli,...args];return execFileSync('node',cmdArgs,{encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer}).trim();}",
        "function parseJsonObject(raw){const txt=String(raw||'').trim();if(!txt)return null;try{return JSON.parse(txt);}catch{}const lines=txt.split(/\\r?\\n/);for(let start=0;start<lines.length;start++){const token=lines[start].trim();if(!(token==='['||token==='{'||token.startsWith('[{')||token.startsWith('{\"')||token.startsWith('[\"')))continue;const candidate=lines.slice(start).join('\\n').trim();try{return JSON.parse(candidate);}catch{}}const compact=lines.map(s=>s.trim()).filter(Boolean);for(let i=compact.length-1;i>=0;i--){const line=compact[i];if(!(line.startsWith('{')||line.startsWith('[')))continue;try{return JSON.parse(line);}catch{}}const start=txt.indexOf('{');const end=txt.lastIndexOf('}');if(start>=0&&end>start){try{return JSON.parse(txt.slice(start,end+1));}catch{}}return null;}",
        "let taskListCache=null;",
        "function normalizeRepo(value){return String(value||'').trim().toLowerCase();}",
        "function listTasks(){",
        "  if(Array.isArray(taskListCache)) return taskListCache;",
        "  try{const raw=runTask(['list','--json']);const tasks=parseJsonObject(raw);taskListCache=Array.isArray(tasks)?tasks:[];return taskListCache;}catch{taskListCache=[];return taskListCache;}",
        "}",
        "function resolveTaskId(item){",
        "  const explicit=String(item?.taskId||'').trim();",
        "  if(explicit) return explicit;",
        "  const branch=String(item?.branch||'').trim();",
        "  if(!branch) return '';",
        "  const repo=normalizeRepo(item?.repo);",
        "  const matches=listTasks().filter((task)=>{",
        "    const taskBranch=String(task?.branchName||'').trim();",
        "    if(taskBranch!==branch) return false;",
        "    const taskRepo=normalizeRepo(task?.repository||'');",
        "    if(!repo || !taskRepo) return true;",
        "    return taskRepo===repo;",
        "  });",
        "  if(matches.length===1) return String(matches[0]?.id||'').trim();",
        "  const exactRepo=matches.find((task)=>normalizeRepo(task?.repository||'')===repo);",
        "  return exactRepo?String(exactRepo?.id||'').trim():'';",
        "}",
        "function getTaskSnapshot(id){",
        "  try{const raw=runTask(['get',id,'--json']);const task=parseJsonObject(raw);return {status:task?.status||null,reviewStatus:task?.reviewStatus||null};}catch{return {status:null,reviewStatus:null};}",
        "}",
        "for(const item of merged){",
        "  const id=resolveTaskId(item);",
        "  if(!id){unresolved.push({taskId:null,repo:String(item?.repo||''),branch:String(item?.branch||''),status:'done',reason:'task_lookup_failed'});continue;}",
        "  try{runTask(['update',id,'--status','done']);updates.push({taskId:id,status:'done'});}catch(e){unresolved.push({taskId:id,status:'done',error:String(e?.message||e)});}",
        "}",
        "for(const item of open){",
        "  const id=resolveTaskId(item);",
        "  if(!id){unresolved.push({taskId:null,repo:String(item?.repo||''),branch:String(item?.branch||''),status:'inreview',reason:'task_lookup_failed'});continue;}",
        "  try{const snap=getTaskSnapshot(id);const current=String(snap?.status||'').trim().toLowerCase();const review=String(snap?.reviewStatus||'').toLowerCase();if(current==='inreview'||current==='done'){updates.push({taskId:id,status:current,skipped:true});continue;}runTask(['update',id,'--status','inreview']);updates.push({taskId:id,status:'inreview',fromStatus:current||null,reviewStatus:review||null});}catch(e){unresolved.push({taskId:id,status:'inreview',error:String(e?.message||e)});}",
        "}",
        "const actionableUnresolved=unresolved.filter((item)=>String(item?.taskId||'').trim());",
        "console.log(JSON.stringify({updated:updates.length,updates,unresolved,actionableUnresolved,needsAgent:actionableUnresolved.length>0}));",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        BOSUN_FETCH_PR_STATE:
          "{{$ctx.getNodeOutput('fetch-pr-state')?.output || '{}'}}",
      },
    }, { x: 400, y: 530 }),

    node("sync-agent-needed", "condition.expression", "Needs Agent Sync?", {
      expression:
        "(()=>{try{" +
        "const raw=$ctx.getNodeOutput('sync-programmatic')?.output||'{}';" +
        "const d=JSON.parse(raw);" +
        "const actionable=Array.isArray(d?.unresolved)?d.unresolved.some((item)=>String(item?.taskId||'').trim()):false;" +
        "return d?.needsAgent===true || actionable;" +
        "}catch{return true;}})()",
    }, { x: 400, y: 615 }),

    node("sync-agent", "action.run_agent", "Sync PR State → Kanban (Fallback)", {
      prompt:
        "You are the Bosun GitHub-Kanban sync fallback agent. A deterministic sync pass already ran.\n\n" +
        "Programmatic sync output:\n" +
        "{{$ctx.getNodeOutput('sync-programmatic')?.output}}\n\n" +
        "Now complete only unresolved updates.\n\n" +
        "GitHub PR state:\n" +
        "PR state (JSON from fetch-pr-state node output):\n" +
        "{{$ctx.getNodeOutput('fetch-pr-state')?.output}}\n\n" +
        "RULES:\n" +
        "1. For each MERGED PR entry with a taskId: update the kanban task to done.\n" +
        "   Use the available bosun CLI, for example:\n" +
        "     node task/task-cli.mjs update <taskId> --status done\n" +
        "   Or inspect available commands with a shell-native file listing.\n" +
        "2. For each OPEN (non-draft) PR entry with a taskId: if the task is not\n" +
        "   already in inreview or done status, update it to inreview.\n" +
        "3. Only act on entries that have a non-null taskId.\n" +
        "4. Log each update and whether it succeeded.\n" +
        "5. Do NOT close, merge, or modify any PR.\n" +
        "6. Do NOT create new tasks — only update existing ones.",
      sdk: "auto",
      timeoutMs: 300_000,
      continueOnError: true,
    }, { x: 400, y: 700 }),

    node("done", "notify.log", "Sync Complete", {
      message: "GitHub ↔ Kanban sync cycle complete",
      level: "info",
    }, { x: 400, y: 700 }),

    node("skip", "notify.log", "No PR Updates", {
      message: "No bosun PR changes to sync this cycle",
      level: "debug",
    }, { x: 650, y: 450 }),
  ],
  edges: [
    edge("trigger", "fetch-pr-state"),
    edge("fetch-pr-state", "has-updates"),
    edge("has-updates", "sync-programmatic", { condition: "$output?.result === true" }),
    edge("has-updates", "skip", { condition: "$output?.result !== true" }),
    edge("sync-programmatic", "sync-agent-needed"),
    edge("sync-agent-needed", "sync-agent", { condition: "$output?.result === true" }),
    edge("sync-agent-needed", "done", { condition: "$output?.result !== true" }),
    edge("sync-agent", "done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-07-10T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "kanban", "sync", "reconcile", "pr", "automation"],
    replaces: {
      module: "github-reconciler.mjs",
      functions: [
        "startGitHubReconciler",
        "stopGitHubReconciler",
        "GitHubReconciler (setInReview, syncMergedPRs, reconcileTaskStatuses)",
      ],
      calledFrom: ["monitor.mjs:restartGitHubReconciler"],
      description:
        "Replaces the legacy github-reconciler.mjs module that polled GitHub PRs " +
        "and updated kanban task statuses (inreview/done) every N minutes. " +
        "This template runs the same reconciliation as an auditable, configurable " +
        "workflow with an agent-driven sync step.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  SDK Conflict Resolver
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const SDK_CONFLICT_RESOLVER_TEMPLATE = {
  id: "template-sdk-conflict-resolver",
  name: "SDK Conflict Resolver",
  description:
    "Intelligent merge-conflict resolution using SDK agents. " +
    "Auto-resolves lockfiles and generated files mechanically, then " +
    "launches an agent with full context to resolve semantic conflicts " +
    "in code, configs, and imports. Verifies resolution and pushes.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    timeoutMs: 600000,
    cooldownMs: 1800000,
    maxAttempts: 4,
    baseBranch: "main",
  },
  nodes: [
    node("trigger", "trigger.event", "Merge Conflict Detected", {
      eventType: "pr.conflict_detected",
      description: "Fires when a PR has merge conflicts that need resolution",
    }, { x: 400, y: 50 }),

    node("check-cooldown", "condition.expression", "On Cooldown?", {
      expression:
        "(() => { " +
        "const last = Number($data?.lastAttemptAt || 0); " +
        "if (!last) return false; " +
        "return (Date.now() - last) < ($data?.cooldownMs || 1800000); " +
        "})()",
    }, { x: 400, y: 200, outputs: ["yes", "no"] }),

    node("check-attempts", "condition.expression", "Attempts Exhausted?", {
      expression:
        "Number($data?.attemptCount || 0) >= Number($data?.maxAttempts || 4)",
    }, { x: 400, y: 350, outputs: ["yes", "no"] }),

    node("get-conflicts", "action.run_command", "List Conflicted Files", {
      command: "git diff --name-only --diff-filter=U",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 400, y: 500 }),

    node("classify-files", "action.set_variable", "Classify Files", {
      key: "fileClassification",
      value:
        "(() => { " +
        "const output = $ctx.getNodeOutput('get-conflicts')?.output || ''; " +
        "const files = output.split('\\n').map(f => f.trim()).filter(Boolean); " +
        "const auto = []; const manual = []; " +
        "const AUTO_THEIRS = ['pnpm-lock.yaml','package-lock.json','yarn.lock','go.sum']; " +
        "const AUTO_OURS = ['CHANGELOG.md','coverage.txt','results.txt']; " +
        "for (const f of files) { " +
        "  const name = f.split('/').pop(); " +
        "  if (AUTO_THEIRS.includes(name) || name.endsWith('.lock')) auto.push({file:f,strategy:'theirs'}); " +
        "  else if (AUTO_OURS.includes(name)) auto.push({file:f,strategy:'ours'}); " +
        "  else manual.push(f); " +
        "} " +
        "return {auto, manual, total: files.length}; " +
        "})()",
      isExpression: true,
    }, { x: 400, y: 650 }),

    node("auto-resolve", "action.run_command", "Auto-Resolve Trivial Files", {
      command:
        "node -e \"" +
        "const files = JSON.parse(process.env.AUTO_FILES || '[]'); " +
        "const {execSync} = require('child_process'); " +
        "let resolved = 0; " +
        "for (const {file, strategy} of files) { " +
        "  try { execSync('git checkout --' + strategy + ' -- ' + file, {cwd: process.env.CWD}); " +
        "  execSync('git add ' + file, {cwd: process.env.CWD}); resolved++; } catch {} " +
        "} " +
        "console.log(JSON.stringify({resolved}));\" ",
      env: {
        AUTO_FILES: "{{fileClassification.auto}}",
        CWD: "{{worktreePath}}",
      },
      continueOnError: true,
    }, { x: 200, y: 800 }),

    node("has-manual", "condition.expression", "Manual Conflicts Remain?", {
      expression:
        "(() => { const c = $data?.fileClassification; return c?.manual?.length > 0; })()",
    }, { x: 400, y: 800, outputs: ["yes", "no"] }),

    node("launch-agent", "action.run_agent", "SDK Agent: Resolve Conflicts", {
      prompt:
        "# Merge Conflict Resolution\n\n" +
        "You are resolving merge conflicts in a git worktree.\n\n" +
        "## Context\n" +
        "- **Working directory**: `{{worktreePath}}`\n" +
        "- **PR branch** (HEAD): `{{branch}}`\n" +
        "- **Base branch** (incoming): `origin/{{baseBranch}}`\n" +
        "- **PR**: #{{prNumber}}\n" +
        "- **Task**: {{taskTitle}}\n\n" +
        "## Conflicted files needing manual resolution:\n" +
        "{{manualFiles}}\n\n" +
        "## Instructions\n" +
        "1. Read both sides of each conflict carefully\n" +
        "2. Understand the INTENT of each change (feature vs upstream)\n" +
        "3. Write a correct resolution that preserves both intents\n" +
        "4. `git add` each resolved file\n" +
        "5. Run `git commit --no-edit` to finalize the merge\n" +
        "6. Do NOT use `--theirs` or `--ours` for code files\n" +
        "7. Ensure no conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) remain",
      sdk: "auto",
      timeoutMs: "{{timeoutMs}}",
      delegationWatchdogTimeoutMs: "{{delegationWatchdogTimeoutMs}}",
      delegationWatchdogMaxRecoveries: "{{delegationWatchdogMaxRecoveries}}",
      failOnError: true,
      continueOnError: true,
    }, { x: 200, y: 950 }),

    node("verify-clean", "action.run_command", "Verify No Markers", {
      command: "git grep -rl '^<<<<<<<\\|^=======\\|^>>>>>>>' -- . || echo CLEAN",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 200, y: 1100 }),

    node("markers-clean", "condition.expression", "Markers Clean?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('verify-clean')?.output || ''; " +
        "return out.trim() === 'CLEAN' || out.trim() === ''; })()",
    }, { x: 200, y: 1250, outputs: ["yes", "no"] }),

    node("push-result", "action.run_command", "Push Resolution", {
      command: "git push origin HEAD:{{branch}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
      maxRetries: 2,
      retryDelayMs: 10000,
    }, { x: 200, y: 1400 }),

    node("commit-auto-only", "action.run_command", "Commit Auto-Only Resolution", {
      command: "git commit --no-edit",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 600, y: 950 }),

    node("push-auto", "action.run_command", "Push Auto Resolution", {
      command: "git push origin HEAD:{{branch}}",
      cwd: "{{worktreePath}}",
      continueOnError: true,
    }, { x: 600, y: 1100 }),

    node("notify-resolved", "notify.log", "Conflict Resolved", {
      message: "SDK conflict resolution succeeded for PR #{{prNumber}} on {{branch}}",
      level: "info",
    }, { x: 400, y: 1550 }),

    node("escalate-cooldown", "notify.log", "On Cooldown", {
      message: "SDK conflict resolution skipped — cooldown active for {{branch}}",
      level: "warn",
    }, { x: 700, y: 200 }),

    node("escalate-exhausted", "notify.telegram", "Max Attempts Reached", {
      message:
        ":warning: Merge conflicts on **{{branch}}** (PR #{{prNumber}}) " +
        "could not be resolved after {{maxAttempts}} SDK attempts. " +
        "Manual intervention required.",
    }, { x: 700, y: 350 }),

    node("escalate-markers", "notify.telegram", "Markers Still Present", {
      message:
        ":alert: SDK agent resolved conflicts on **{{branch}}** but conflict " +
        "markers remain. Manual review needed for PR #{{prNumber}}.",
    }, { x: 500, y: 1400 }),

    node("chain-merge-strategy", "action.execute_workflow", "Re-evaluate Merge", {
      workflowId: "template-pr-merge-strategy",
      mode: "dispatch",
      input: "({prNumber: $data?.prNumber, branch: $data?.branch, baseBranch: $data?.baseBranch})",
    }, { x: 200, y: 1550 }),
  ],
  edges: [
    edge("trigger", "check-cooldown"),
    edge("check-cooldown", "escalate-cooldown", { condition: "$output?.result === true", port: "yes" }),
    edge("check-cooldown", "check-attempts", { condition: "$output?.result !== true", port: "no" }),
    edge("check-attempts", "escalate-exhausted", { condition: "$output?.result === true", port: "yes" }),
    edge("check-attempts", "get-conflicts", { condition: "$output?.result !== true", port: "no" }),
    edge("get-conflicts", "classify-files"),
    edge("classify-files", "auto-resolve"),
    edge("auto-resolve", "has-manual"),
    edge("has-manual", "launch-agent", { condition: "$output?.result === true", port: "yes" }),
    edge("has-manual", "commit-auto-only", { condition: "$output?.result !== true", port: "no" }),
    edge("launch-agent", "verify-clean"),
    edge("verify-clean", "markers-clean"),
    edge("markers-clean", "push-result", { condition: "$output?.result === true", port: "yes" }),
    edge("markers-clean", "escalate-markers", { condition: "$output?.result !== true", port: "no" }),
    edge("push-result", "chain-merge-strategy"),
    edge("chain-merge-strategy", "notify-resolved"),
    edge("commit-auto-only", "push-auto"),
    edge("push-auto", "notify-resolved"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "merge", "conflict", "sdk", "agent", "resolution"],
    requiredTemplates: ["template-pr-merge-strategy"],
    replaces: {
      module: "sdk-conflict-resolver.mjs",
      functions: [
        "resolveConflictsWithSDK",
        "buildSDKConflictPrompt",
        "isSDKResolutionOnCooldown",
        "isSDKResolutionExhausted",
      ],
      calledFrom: [
        "conflict-resolver.mjs:resolveConflicts",
        "monitor.mjs:handleMergeConflict",
      ],
      description:
        "Replaces the imperative sdk-conflict-resolver.mjs with a visual " +
        "workflow. File classification, auto-resolve, SDK agent launch, " +
        "marker verification, and push become auditable nodes. Chains " +
        "into PR Merge Strategy after successful resolution.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  GitHub PR Event Handler — event-driven (replaces 90s polling for PR opens)
//  Fires instantly when a PR is opened, updated (synchronize), or reopened.
//  Finds the linked Bosun task via branch name and marks it in-review.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const GITHUB_PR_EVENT_HANDLER_TEMPLATE = {
  id: "template-github-pr-event-handler",
  name: "GitHub PR Event Handler",
  description:
    "Event-driven workflow that fires as soon as a PR is opened, updated, or reopened " +
    "via GitHub webhook. Identifies the linked Bosun task by branch name and " +
    "immediately updates its status to in-review — no polling required. " +
    "Complements the PR Watchdog which runs every 30 minutes as a fallback.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    labelInReview: "bosun/in-review",
    taskBranchPrefix: "task/",
  },
  nodes: [
    node("trigger", "trigger.event", "PR Opened / Updated", {
      eventType: "github:pull_request",
      filter: "['opened','synchronize','reopened'].includes(String($event?.action || '').toLowerCase())",
    }, { x: 400, y: 50 }),

    node("check-bosun-branch", "condition.expression", "Is a Bosun Task Branch?", {
      expression: "Boolean($data?.prBranch) && String($data?.prBranch || '').startsWith(String($data?.taskBranchPrefix || 'task/'))",
    }, { x: 400, y: 190, outputs: ["yes", "no"] }),

    node("find-task", "action.run_command", "Find Linked Task", {
      command: "node",
      args: ["-e", `
        const fs = require("node:fs");
        const path = require("node:path");
        const { pathToFileURL } = require("node:url");
        let repoRoot = process.cwd();
        const mirrorMarker = (path.sep + ".bosun" + path.sep + "workspaces" + path.sep).toLowerCase();
        if (repoRoot.toLowerCase().includes(mirrorMarker)) {
          const r = path.resolve(repoRoot, "..", "..", "..", "..");
          if (fs.existsSync(path.join(r, "kanban", "kanban-adapter.mjs"))) repoRoot = r;
        }
        const kanbanUrl = pathToFileURL(path.join(repoRoot, "kanban", "kanban-adapter.mjs")).href;
        const branch = process.env.PR_BRANCH || "";
        import(kanbanUrl)
          .then(k => k.listTasks(undefined, {}))
          .then(tasks => {
            const task = (tasks || []).find(t =>
              (t.branch || t.metadata?.branch) === branch
            );
            console.log(JSON.stringify(task || null));
          })
          .catch(e => { console.error(e.message); process.exit(1); });
      `],
      env: { PR_BRANCH: "{{prBranch}}" },
      parseJson: true,
    }, { x: 250, y: 340 }),

    node("check-task-found", "condition.expression", "Task Found?", {
      expression: "Boolean($ctx.getNodeOutput('find-task')?.output?.id)",
    }, { x: 250, y: 490, outputs: ["yes", "no"] }),

    node("update-inreview", "action.update_task_status", "Mark Task In Review", {
      taskId:        "{{$ctx.getNodeOutput('find-task')?.output?.id || ''}}",
      status:        "inreview",
      taskTitle:     "{{$ctx.getNodeOutput('find-task')?.output?.title || prTitle || ''}}",
      workflowEvent: "task.in_review",
      workflowData: {
        source:   "github:pr_opened",
        prNumber: "{{prNumber}}",
        prUrl:    "{{prUrl}}",
        branch:   "{{prBranch}}",
        repo:     "{{repo}}",
      },
    }, { x: 250, y: 640 }),

    node("add-label-in-review", "action.run_command", "Add In-Review Label", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const n=String(process.env.PR_NUMBER||'').trim();",
        "const repo=String(process.env.REPO||'').trim();",
        "const label=String(process.env.LABEL_IN_REVIEW||'bosun/in-review').trim();",
        "if(!n||!label){process.exit(0);}",
        "try{",
        "  const args=['pr','edit',n,'--add-label',label];",
        "  if(repo)args.push('--repo',repo);",
        "  execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']});",
        "  console.log(JSON.stringify({labeled:true,label,pr:n}));",
        "}catch(e){",
        "  process.stderr.write('label warn: '+String(e?.message||e)+'\\n');",
        "  console.log(JSON.stringify({labeled:false,label,pr:n,error:String(e?.message||e)}));",
        "}",
      ].join(" ")],
      continueOnError: true,
      failOnError: false,
      env: {
        PR_NUMBER: "{{prNumber}}",
        REPO: "{{repo}}",
        LABEL_IN_REVIEW: "{{labelInReview}}",
      },
    }, { x: 250, y: 720 }),

    node("log-updated", "notify.log", "Log In Review", {
      message: ":rocket: Task {{$ctx.getNodeOutput('find-task')?.output?.id}} moved to in-review — PR #{{prNumber}} ({{prBranch}}) in {{repo}}",
      level: "info",
    }, { x: 250, y: 790 }),

    node("log-no-task", "notify.log", "Log No Task Found", {
      message: "PR #{{prNumber}} opened on branch {{prBranch}} in {{repo}} — no linked Bosun task found.",
      level: "debug",
    }, { x: 550, y: 490 }),

    node("log-not-bosun", "notify.log", "Log Non-Bosun Branch", {
      message: "PR #{{prNumber}} on {{prBranch}} is not a Bosun task branch — skipping.",
      level: "debug",
    }, { x: 650, y: 340 }),
  ],
  edges: [
    edge("trigger",         "check-bosun-branch"),
    edge("check-bosun-branch", "find-task",       { condition: "$output?.result === true",  port: "yes" }),
    edge("check-bosun-branch", "log-not-bosun",   { condition: "$output?.result !== true",  port: "no" }),
    edge("find-task",       "check-task-found"),
    edge("check-task-found", "update-inreview",   { condition: "$output?.result === true",  port: "yes" }),
    edge("check-task-found", "log-no-task",       { condition: "$output?.result !== true",  port: "no" }),
    edge("update-inreview", "add-label-in-review"),
    edge("add-label-in-review", "log-updated"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "event-driven", "lifecycle", "webhook"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  GitHub Check Failure Handler — event-driven
//  Fires instantly when a GitHub check run fails on a PR branch.
//  Labels the PR bosun-needs-fix so the Watchdog's next sweep picks it up
//  for agent repair — no 30-minute wait to know a check failed.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const GITHUB_CHECK_FAILURE_TEMPLATE = {
  id: "template-github-check-failure",
  name: "GitHub Check Failure Handler",
  description:
    "Event-driven workflow that fires the moment a GitHub check run fails. " +
    "Identifies the associated PR and applies the bosun-needs-fix label instantly " +
    "so the PR Watchdog can dispatch a repair agent on its next sweep. " +
    "Eliminates the up-to-30-minute delay between a CI failure and Bosun's response.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    labelNeedsFix: "bosun-needs-fix",
    ignoredCheckNames: "codecov,dependabot,semantic-pr-title",
  },
  nodes: [
    node("trigger", "trigger.event", "Check Run Failed", {
      eventType: "github:check_run",
      filter:
        "$event?.action === 'completed' && " +
        "$event?.checkConclusion === 'failure' && " +
        "!String($event?.checkName || '').split(',').some(n => " +
        "  String($data?.ignoredCheckNames || '').toLowerCase().split(',').map(s => s.trim()).includes(n.trim().toLowerCase())" +
        ")",
    }, { x: 400, y: 50 }),

    node("check-has-pr", "condition.expression", "Associated PR Found?", {
      expression: "Number($data?.prNumber) > 0 && Boolean($data?.repo)",
    }, { x: 400, y: 190, outputs: ["yes", "no"] }),

    node("label-fix", "action.run_command", "Label PR: bosun-needs-fix", {
      command: "gh",
      args: ["pr", "edit", "{{prNumber}}", "--add-label", "{{labelNeedsFix}}", "--repo", "{{repo}}"],
      continueOnError: true,
    }, { x: 250, y: 340 }),

    node("log-labeled", "notify.log", "Log Fix Label Applied", {
      message:
        ":x: Check '{{checkName}}' failed on PR #{{prNumber}} ({{repo}}). " +
        "Applied label '{{labelNeedsFix}}' — PR Watchdog will dispatch repair.",
      level: "warn",
    }, { x: 250, y: 490 }),

    node("log-no-pr", "notify.log", "Log No Associated PR", {
      message: "Check '{{checkName}}' failed in {{repo}} (conclusion: {{checkConclusion}}) — no associated PR found.",
      level: "debug",
    }, { x: 620, y: 340 }),
  ],
  edges: [
    edge("trigger",     "check-has-pr"),
    edge("check-has-pr", "label-fix",    { condition: "$output?.result === true",  port: "yes" }),
    edge("check-has-pr", "log-no-pr",    { condition: "$output?.result !== true",  port: "no" }),
    edge("label-fix",   "log-labeled"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "ci", "check", "event-driven", "webhook", "reliability"],
  },
};
