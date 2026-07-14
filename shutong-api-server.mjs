/*
  舒痛演示 API：用服务器保存 API Key，前端只请求 /api/plan。
  启动：$env:DEEPSEEK_API_KEY='...'; node shutong-api-server.mjs
  访问：http://localhost:8787/shutong-app.html
*/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PROVIDER = process.env.AI_PROVIDER || 'deepseek'; // deepseek | openai
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const REQUEST_LIMIT = 30_000;
const MODEL_TIMEOUT_MS = 15_000;
const APP_ACCESS_PASSWORD = process.env.APP_ACCESS_PASSWORD || '';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

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
  required: ['headline', 'why', 'goal_statement', 'weekly_rhythm', 'today_action_id', 'action_ids'],
  properties: {
    headline: { type: 'string', maxLength: 48 },
    why: { type: 'string', maxLength: 140 },
    goal_statement: { type: 'string', maxLength: 96 },
    weekly_rhythm: { type: 'string', maxLength: 180 },
    today_action_id: { type: 'string', enum: actionIds },
    action_ids: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: actionIds } }
  }
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(body);
}
function passwordMatches(password) {
  const expected = Buffer.from(APP_ACCESS_PASSWORD);
  const actual = Buffer.from(String(password || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function cookieValue(req, name) {
  const match = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}
function sessionSignature(expiresAt) {
  return createHmac('sha256', APP_ACCESS_PASSWORD).update(`shutong-session:${expiresAt}`).digest('base64url');
}
function hasValidSession(req) {
  const [expiresAt, signature] = cookieValue(req, 'shutong_session').split('.');
  if (!/^\d+$/.test(expiresAt || '') || Number(expiresAt) <= Date.now() || !signature) return false;
  const expected = Buffer.from(sessionSignature(expiresAt));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function isAuthorized(req) {
  if (!APP_ACCESS_PASSWORD) return true;
  if (hasValidSession(req)) return true;
  const encoded = String(req.headers.authorization || '').replace(/^Basic\s+/i, '');
  let password = '';
  try { password = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':'); } catch { return false; }
  return passwordMatches(password);
}
function loginPage(error = '') {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>舒痛 · 访问验证</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f7f6;color:#14383a;font-family:"Microsoft YaHei",sans-serif}.box{width:min(360px,calc(100% - 40px);padding:30px;border:1px solid #d8e8e5;border-radius:22px;background:#fff;box-shadow:0 18px 48px #19433e20}h1{margin:0 0 8px;font-size:25px}p{color:#67817e;font-size:14px;line-height:1.65}.error{color:#a83832;background:#fff0ef;padding:9px 11px;border-radius:10px}input,button{box-sizing:border-box;width:100%;font:inherit;border-radius:12px}input{margin:12px 0;border:1px solid #b9d8d3;padding:13px}button{border:0;background:#087d72;color:#fff;padding:13px;font-weight:700;cursor:pointer}.foot{margin-top:18px;font-size:12px;color:#67817e}</style><main class="box"><h1>舒痛</h1><p>请输入访问密码，继续使用个人疼痛管理工具。</p>${error ? `<div class="error">${error}</div>` : ''}<form method="post" action="/login"><input name="password" type="password" autocomplete="current-password" autofocus required placeholder="访问密码"><button type="submit">进入舒痛</button></form><p class="foot">此工具用于自我记录与行动支持，不提供诊断或处方。</p></main></html>`;
}
async function requestBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > REQUEST_LIMIT) throw new Error('Request too large'); }
  return raw;
}
function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
  res.end();
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
    short_term: value.short_term === true,
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
  const todayActionId = picked.includes(payload?.today_action_id) ? payload.today_action_id : picked[0];
  return {
    headline: safeModelText(payload?.headline, 48) || '从一个小而可调整的行动开始',
    why: safeModelText(payload?.why, 140) || '根据你的目标，先安排可观察、可调整的低风险行动。',
    goal_statement: goalStatement,
    weekly_rhythm: safeModelText(payload?.weekly_rhythm, 180) || '本周先用小幅、可调整的节奏练习这些行动；任何不适加重或出现新症状时先暂停并联系专业人员。',
    today_action_id: todayActionId,
    actions: picked.map(id => actionMap[id])
  };
}
function safeModelText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return text && !/(诊断|处方|药物|剂量|加量|减量)/.test(text) ? text : null;
}
async function createPlan(context) {
  const instructions = `You select a small, achievable self-management plan from an approved action library for an adult pain-management education product. This is NOT diagnosis or medical treatment. Do not recommend medication, doses, exercises beyond the library, stretching, loading, or claims of cure. Do not use pain scores as a target. Choose 2 or 3 action_ids only from the provided list. Also provide goal_statement: a concise Chinese restatement of the user's life/function goal, not a medical goal and not an instruction. Provide weekly_rhythm: one concise Chinese sentence describing a flexible, non-medical rhythm for this week. Provide today_action_id: exactly one id from the selected action_ids that is most suitable as today's first step. When short_term is true, make the headline and selected actions suitable for a small, immediately doable adjustment after the just-recorded symptoms; do not mention diagnosis, treatment, or a recovery promise. Aggregate action feedback may be supplied; use it only to prefer a smaller, more adjustable action selection when pauses are reported. Do not infer a cause. If the context has urgent symptoms, the client must not call this endpoint; do not make triage claims. Write concise Chinese.\n\nApproved action IDs:\n${ACTIONS.map(([id, title, detail]) => `- ${id}: ${title}; ${detail}`).join('\n')}`;
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
        { role: 'system', content: `${instructions}\n\nReturn one JSON object with only headline, why, goal_statement, weekly_rhythm, today_action_id and action_ids.` },
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
  if (APP_ACCESS_PASSWORD && req.method === 'GET' && url.pathname === '/login') {
    if (isAuthorized(req)) return redirect(res, '/');
    return html(res, 200, loginPage());
  }
  if (APP_ACCESS_PASSWORD && req.method === 'POST' && url.pathname === '/login') {
    let password = '';
    try { password = new URLSearchParams(await requestBody(req)).get('password') || ''; }
    catch { return html(res, 413, loginPage('提交内容过大，请重试。')); }
    if (!passwordMatches(password)) return html(res, 401, loginPage('访问密码不正确，请重试。'));
    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    const token = `${expiresAt}.${sessionSignature(expiresAt)}`;
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || req.socket.encrypted ? '; Secure' : '';
    return redirect(res, '/', { 'set-cookie': `shutong_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}` });
  }
  if (APP_ACCESS_PASSWORD && req.method === 'POST' && url.pathname === '/logout') {
    return redirect(res, '/login', { 'set-cookie': 'shutong_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }
  if (!isAuthorized(req) && !(req.method === 'GET' && url.pathname === '/api/health')) {
    if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'AUTH_REQUIRED', message: '请重新输入访问密码。' });
    return redirect(res, '/login');
  }
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
    try { raw = await requestBody(req); }
    catch { return json(res, 413, { error: 'Request too large' }); }
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
