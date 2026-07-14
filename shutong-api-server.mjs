/*
  舒痛演示 API：用服务器保存 API Key，前端只请求 /api/plan。
  启动：$env:DEEPSEEK_API_KEY='...'; node shutong-api-server.mjs
  访问：http://localhost:8787/shutong-app.html
*/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PROVIDER = process.env.AI_PROVIDER || 'deepseek'; // deepseek | openai
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const REQUEST_LIMIT = 30_000;
const MODEL_TIMEOUT_MS = 15_000;
const APP_ACCESS_PASSWORD = process.env.APP_ACCESS_PASSWORD || '';

// 生成模型只能从这份经临床团队审核的低风险行动库中选择，不能编造医疗建议。
const ACTIONS = [
  ['pacing_break', '设置活动间隔', '在可行时设置一个轻活动提醒，并按当天耐受度调整。'],
  ['short_walk', '短时轻松走动', '选择平稳、舒适的环境，短时走动；若症状明显加重则停止。'],
  ['comfort_position', '舒适姿势重置', '改变坐、站或躺姿，优先选择能让身体放松的位置。'],
  ['symptom_log', '完成一次恢复记录', '记录疼痛、功能、睡眠或压力中的一两项，帮助观察规律。'],
  ['sleep_wind_down', '安排睡前降速', '睡前留出一段低刺激、可重复的放松时间。'],
  ['breathing', '两分钟呼吸放松', '以舒适为主，缓慢呼气并观察紧张感是否变化。'],
  ['work_reset', '工作任务微调', '把需要重复扭转或久保持姿势的工作分成更小的段落。'],
  ['social_support', '联系一位可信任的人', '用一句话说明你今天的状态，并提出一个具体的小请求。'],
  ['prepare_visit', '准备就诊问题', '写下最影响生活的一件事和最想向专业人员确认的问题。']
];
const actionMap = Object.fromEntries(ACTIONS.map(([id, title, detail]) => [id, { id, title, detail }]));
const actionIds = ACTIONS.map(([id]) => id);

const schema = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'why', 'goal_statement', 'action_ids'],
  properties: {
    headline: { type: 'string', maxLength: 48 },
    why: { type: 'string', maxLength: 140 },
    goal_statement: { type: 'string', maxLength: 96 },
    action_ids: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: actionIds } }
  }
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function isAuthorized(req) {
  if (!APP_ACCESS_PASSWORD) return true;
  const encoded = String(req.headers.authorization || '').replace(/^Basic\s+/i, '');
  let password = '';
  try { password = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':'); } catch { return false; }
  const expected = Buffer.from(APP_ACCESS_PASSWORD);
  const actual = Buffer.from(password);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function requestAuth(res) {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="Shutong", charset="UTF-8"', 'cache-control': 'no-store' });
  res.end('需要访问密码。');
}
function publicError(error) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('DEEPSEEK_API_KEY') || message.includes('OPENAI_API_KEY')) return '服务端尚未配置 API Key。';
  if (message.includes('Unsupported AI_PROVIDER')) return 'AI_PROVIDER 配置无效。';
  if (message.includes('abort')) return 'AI 服务响应超时。';
  if (message.includes('request failed: 401')) return 'API Key 无效或已失效。';
  if (message.includes('request failed: 429')) return 'AI 服务暂时限流，请稍后重试。';
  return 'AI 服务暂时不可用，请稍后重试。';
}
function cleanText(value, max = 160) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}
function cleanList(value, maxItems = 9, itemMax = 40) {
  return Array.isArray(value) ? value.slice(0, maxItems).map(item => cleanText(item, itemMax)).filter(Boolean) : [];
}
function safeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.urgent === true) return null;
  const record = value.latest_record && typeof value.latest_record === 'object' ? value.latest_record : {};
  const environment = value.environment && typeof value.environment === 'object' ? value.environment : {};
  const feedback = value.action_feedback && typeof value.action_feedback === 'object' ? value.action_feedback : {};
  const intensity = Number(record.pain_intensity);
  return {
    goal: cleanText(value.goal, 120),
    goal_note: cleanText(value.goal_note, 240),
    latest_record: {
      pain_intensity: Number.isFinite(intensity) && intensity >= 0 && intensity <= 10 ? intensity : null,
      sites: cleanList(record.sites), qualities: cleanList(record.qualities), function_impact: cleanList(record.function_impact)
    },
    environment: { work: cleanText(environment.work, 80), commute: cleanText(environment.commute, 80), selected_changes: cleanList(environment.selected_changes, 5, 100) },
    action_feedback: { completed_count: Number.isInteger(feedback.completed_count) && feedback.completed_count >= 0 && feedback.completed_count <= 30 ? feedback.completed_count : 0, paused_count: Number.isInteger(feedback.paused_count) && feedback.paused_count >= 0 && feedback.paused_count <= 30 ? feedback.paused_count : 0, skipped_count: Number.isInteger(feedback.skipped_count) && feedback.skipped_count >= 0 && feedback.skipped_count <= 30 ? feedback.skipped_count : 0 }
  };
}
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
function safePlan(payload) {
  const picked = Array.isArray(payload?.action_ids) ? payload.action_ids.filter(id => actionMap[id]).slice(0, 3) : [];
  const goalStatement = safeModelText(payload?.goal_statement, 96);
  if (picked.length < 2 || !goalStatement) return null;
  return { headline: safeModelText(payload?.headline, 48) || '从一个小而可调整的行动开始', why: safeModelText(payload?.why, 140) || '根据你的目标，先安排可观察、可调整的低风险行动。', goal_statement: goalStatement, actions: picked.map(id => actionMap[id]) };
}
function safeModelText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return text && !/(诊断|处方|药物|剂量|加量|减量)/.test(text) ? text : null;
}
async function createPlan(context) {
  const instructions = `You select a small, achievable self-management plan from an approved action library for an adult pain-management education product. This is NOT diagnosis or medical treatment. Do not recommend medication, doses, exercises beyond the library, stretching, loading, or claims of cure. Do not use pain scores as a target. Choose 2 or 3 action_ids only from the provided list. Also provide goal_statement: a concise Chinese restatement of the user's life/function goal, not a medical goal and not an instruction. Aggregate action feedback may be supplied; use it only to prefer a smaller, more adjustable action selection when pauses are reported. Do not infer a cause. If the context has urgent symptoms, the client must not call this endpoint; do not make triage claims. Write concise Chinese.\n\nApproved action IDs:\n${ACTIONS.map(([id, title, detail]) => `- ${id}: ${title}; ${detail}`).join('\n')}`;
  if (PROVIDER === 'deepseek') return createDeepSeekPlan(context, instructions);
  if (PROVIDER === 'openai') return createOpenAIPlan(context, instructions);
  throw new Error(`Unsupported AI_PROVIDER: ${PROVIDER}`);
}
async function createDeepSeekPlan(context, instructions) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured');
  const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: `${instructions}\n\nReturn one JSON object with only headline, why, goal_statement and action_ids.` },
        { role: 'user', content: JSON.stringify(context) }
      ],
      response_format: { type: 'json_object' },
      stream: false
    })
  });
  if (!response.ok) throw new Error(`DeepSeek request failed: ${response.status}`);
  const data = await response.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '');
  const plan = safePlan(parsed);
  if (!plan) throw new Error('Model returned an invalid action selection');
  return plan;
}
async function createOpenAIPlan(context, instructions) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions,
      input: JSON.stringify(context),
      text: { format: { type: 'json_schema', name: 'pain_plan', strict: true, schema } }
    })
  });
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
  const data = await response.json();
  const parsed = JSON.parse(data.output_text);
  const plan = safePlan(parsed);
  if (!plan) throw new Error('Model returned an invalid action selection');
  return plan;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!isAuthorized(req) && !(req.method === 'GET' && url.pathname === '/api/health')) return requestAuth(res);
  const origin = req.headers.origin;
  if (origin === 'null' || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}` || origin === `http://${req.headers.host}`) res.setHeader('access-control-allow-origin', origin);
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }); return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (url.pathname === '/api/goal' || url.pathname === '/api/plan')) {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'Expected JSON request' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > REQUEST_LIMIT) return json(res, 413, { error: 'Request too large' }); }
    let context;
    try { context = safeContext(JSON.parse(raw || '{}')); }
    catch { return json(res, 400, { error: 'Invalid JSON request' }); }
    if (!context || !context.goal) return json(res, 400, { error: 'Invalid plan context' });
    try {
      const plan = await createPlan(context);
      return json(res, 200, url.pathname === '/api/goal' ? { goal_statement: plan.goal_statement, why: plan.why } : plan);
    }
    catch (error) {
      console.error('AI generation failed:', error instanceof Error ? error.message : 'unknown error');
      return json(res, 503, { error: 'AI_UNAVAILABLE', message: publicError(error) });
    }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/shutong-app.html')) {
    try {
      const html = await readFile(join(root, 'shutong-app.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); return res.end(html);
    } catch { return res.end('Missing shutong-app.html'); }
  }
  json(res, 404, { error: 'Not found' });
}).listen(PORT, HOST, () => console.log(`舒痛 Demo: http://${HOST}:${PORT}/shutong-app.html`));
