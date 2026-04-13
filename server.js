import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ─── Resource Loader ──────────────────────────────────────────────────────────

function loadResources() {
  const resourcesDir = join(__dirname, 'resources');
  const resources = {};

  function scanDir(dir, prefix = '') {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath, prefix + entry + '/');
      } else if (extname(entry) === '.md') {
        const key = prefix + entry;
        try {
          resources[key] = readFileSync(fullPath, 'utf-8');
        } catch (e) {
          console.warn(`Could not read ${fullPath}: ${e.message}`);
        }
      }
    }
  }

  scanDir(resourcesDir);
  return resources;
}

function buildSystemPrompt(resources) {
  // Priority hook files — the "All ..." compilations cover all formulas comprehensively
  // Plus key strategy/how-to files. This keeps the prompt under ~30K tokens.
  const priorityPatterns = [
    /^hooks\/All /,
    /^hooks\/100 /,
    /^hooks\/How to Write/,
    /^hooks\/Hooks - Do/,
    /^hooks\/The elements/,
    /^hooks\/Successful Hooks/,
    /^hooks\/High Impact/,
    /^hooks\/Tips for Writing/,
    /^hooks\/Attention-Grabbing/,
    /^hooks\/Visual Hooks/,
    /^hooks\/Authority/,
    /^hooks\/Viral Transitional/,
  ];

  const hooksDir = Object.entries(resources)
    .filter(([k]) => priorityPatterns.some(p => p.test(k)))
    .map(([k, v]) => `\n\n### ${k.replace('hooks/', '').replace('.md', '')}\n${v}`)
    .join('');

  const poshaContext = resources['posha-product-context.md'] || '';
  const creatorNotes = resources['posha-creator-notes.md'] || '';

  return `You are the Posha Hook Generator — an expert social media hook writer specialized in creating viral TikTok and Instagram Reels hooks for Posha, an autonomous kitchen robot that cooks real meals.

## YOUR MISSION
Generate scroll-stopping hooks that make people stop, watch, and want Posha. Every hook must feel native to short-form video — punchy, specific, and grounded in real human desire (saving time, eating well, impressing family, reducing stress).

## POSHA PRODUCT CONTEXT
${poshaContext}

## CREATOR NOTES & STRATEGY
${creatorNotes}

## YOUR HOOK VAULT (150+ formulas across 15+ categories)
Use these formulas as a foundation. Mix, match, and adapt them to Posha's unique value props. Always fill in the blanks with Posha-specific content — never leave template placeholders.
${hooksDir}

## HOOK WRITING RULES
1. **First 3 words are everything** — they must create immediate curiosity, relatability, or shock
2. **Be specific** — "saves 2 hours every night" beats "saves time"
3. **Speak to the viewer** — use "you", address their real life
4. **No fluff** — every word must earn its place
5. **Visual-first thinking** — imagine what's on screen as you write the hook
6. **Avoid clichés** — don't use "game-changer" or "life-changing" as your only hook
7. **Match creator voice** — adapt tone to the specific creator's style
8. **Name the vault formula** — always cite which formula/category you used

## OUTPUT FORMAT
For each hook, provide:
- **HOOK**: The actual hook text (1–3 sentences max)
- **FORMULA**: Which vault formula it's based on
- **CATEGORY**: Hook category (curiosity, problem-solution, storytelling, etc.)
- **VISUAL CUE**: What should be happening on screen
- **WHY IT WORKS**: 1-sentence explanation of the psychological trigger

Generate hooks that are ready to use — no placeholders, no templates. Always Posha-specific.`;
}

// ─── Anthropic Client ─────────────────────────────────────────────────────────

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Web Search Tool ──────────────────────────────────────────────────────────

const webSearchTool = {
  type: 'web_search_20250305',
  name: 'web_search',
};

// ─── Hook Generation ──────────────────────────────────────────────────────────

async function generateHooks({ creatorName, creatorNotes, category, count = 5, research = false }, onChunk) {
  const resources = loadResources();
  const systemPrompt = buildSystemPrompt(resources);

  let userMessage = `Generate ${count} high-quality Posha hooks`;

  if (creatorName) {
    userMessage += ` for creator: **${creatorName}**`;
  }

  if (creatorNotes) {
    userMessage += `\n\n**Creator Notes / Brief:**\n${creatorNotes}`;
  }

  if (category) {
    userMessage += `\n\n**Preferred Hook Category:** ${category}`;
  }

  if (research) {
    userMessage += `\n\n**Research Mode ON:** First search the web for current trends, viral hooks, and what's working in the cooking/kitchen/food automation space on TikTok and Instagram Reels in 2024-2025. Then use those insights to make the hooks even more relevant and timely.`;
  }

  userMessage += `\n\nMake each hook distinct — vary the formula, emotional trigger, and angle. Ensure all hooks are 100% Posha-specific with no unfilled placeholders.`;

  const tools = research ? [webSearchTool] : [];

  console.log(`[API] Sending request — model: claude-sonnet-4-20250514, system prompt: ${systemPrompt.length} chars, user message: ${userMessage.length} chars`);

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    ...(tools.length > 0 ? { tools } : {}),
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        onChunk({ type: 'text', text: event.delta.text });
      } else if (event.delta.type === 'thinking_delta') {
        onChunk({ type: 'thinking', text: event.delta.thinking });
      }
    } else if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        onChunk({ type: 'tool_start', name: event.content_block.name });
      }
    } else if (event.type === 'message_stop') {
      onChunk({ type: 'done' });
    }
  }
}

// ─── Scheduled Generation ─────────────────────────────────────────────────────

const scheduledJobs = new Map();
const generatedHooksLog = [];

function ensureOutputDir() {
  const dir = join(__dirname, 'generated');
  if (!existsSync(dir)) mkdirSync(dir);
  return dir;
}

function scheduleJob(id, cronExpression, config) {
  if (scheduledJobs.has(id)) {
    scheduledJobs.get(id).task.stop();
  }

  const task = cron.schedule(cronExpression, async () => {
    console.log(`[Scheduled] Running hook generation job: ${id}`);
    const chunks = [];
    try {
      await generateHooks(config, (chunk) => {
        if (chunk.type === 'text') chunks.push(chunk.text);
      });
      const result = chunks.join('');
      const timestamp = new Date().toISOString();
      const outputDir = ensureOutputDir();
      const filename = join(outputDir, `${id}-${timestamp.replace(/[:.]/g, '-')}.md`);
      writeFileSync(filename, `# Posha Hooks — ${timestamp}\n\n${result}`);
      generatedHooksLog.push({ id, timestamp, filename, preview: result.substring(0, 200) });
      console.log(`[Scheduled] Saved hooks to ${filename}`);
    } catch (e) {
      console.error(`[Scheduled] Job ${id} failed:`, e.message);
    }
  });

  scheduledJobs.set(id, { task, cronExpression, config });
  console.log(`[Scheduled] Job ${id} scheduled: ${cronExpression}`);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/status — health check + resource count
app.get('/api/status', (req, res) => {
  const resources = loadResources();
  const hookFiles = Object.keys(resources).filter(k => k.startsWith('hooks/')).length;
  res.json({
    status: 'ok',
    resourceFiles: Object.keys(resources).length,
    hookFiles,
    scheduledJobs: scheduledJobs.size,
    model: 'claude-sonnet-4-20250514',
  });
});

// GET /api/resources — list available resource files
app.get('/api/resources', (req, res) => {
  const resources = loadResources();
  res.json({
    files: Object.keys(resources).sort(),
    count: Object.keys(resources).length,
  });
});

// POST /api/generate — generate hooks (streaming SSE)
app.post('/api/generate', async (req, res) => {
  const { creatorName, creatorNotes, category, count, research } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    await generateHooks(
      { creatorName, creatorNotes, category, count: count || 5, research: research || false },
      (chunk) => send(chunk)
    );
  } catch (err) {
    console.error('[API Error]', err.status, err.message, err.error || '');
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// GET /api/schedule — list scheduled jobs
app.get('/api/schedule', (req, res) => {
  const jobs = [];
  for (const [id, { cronExpression, config }] of scheduledJobs) {
    jobs.push({ id, cronExpression, config });
  }
  res.json({ jobs, recentLogs: generatedHooksLog.slice(-10) });
});

// POST /api/schedule — create or update a scheduled job
app.post('/api/schedule', (req, res) => {
  const { id, cronExpression, config } = req.body;
  if (!id || !cronExpression || !config) {
    return res.status(400).json({ error: 'id, cronExpression, and config are required' });
  }
  if (!cron.validate(cronExpression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }
  scheduleJob(id, cronExpression, config);
  res.json({ success: true, id, cronExpression });
});

// DELETE /api/schedule/:id — remove a scheduled job
app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  if (scheduledJobs.has(id)) {
    scheduledJobs.get(id).task.stop();
    scheduledJobs.delete(id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🍳 Posha Hook Generator running at http://localhost:${PORT}`);
  const resources = loadResources();
  const hookCount = Object.keys(resources).filter(k => k.startsWith('hooks/')).length;
  console.log(`📚 Loaded ${Object.keys(resources).length} resource files (${hookCount} hook vault files)`);
  console.log(`🤖 Model: claude-sonnet-4-20250514 with adaptive thinking\n`);
});
