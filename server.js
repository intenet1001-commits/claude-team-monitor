const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 9099;
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const STATS_FILE = path.join(CLAUDE_DIR, '.session-stats.json');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// In-memory state
const state = {
  teams: {},
  tasks: {},
  tmuxOutputs: {},   // agentId → lines string
  messages: {},      // teamName → messages array
  stats: {}
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ─── Data readers ────────────────────────────────────────────────────────────

function readTeams() {
  if (!fs.existsSync(TEAMS_DIR)) return;
  const teams = {};
  try {
    fs.readdirSync(TEAMS_DIR).forEach(name => {
      const config = readJson(path.join(TEAMS_DIR, name, 'config.json'));
      if (config) teams[name] = config;
    });
  } catch {}
  state.teams = teams;
  broadcast('teams', teams);
}

function readMessages(teamName) {
  const msgPath = path.join(TEAMS_DIR, teamName, 'messages.json');
  if (!fs.existsSync(msgPath)) return;
  const messages = readJson(msgPath);
  if (messages) {
    state.messages[teamName] = messages;
    broadcast('messages', { teamName, messages });
  }
}

function readAllMessages() {
  Object.keys(state.teams).forEach(readMessages);
}

function readTasks() {
  if (!fs.existsSync(TASKS_DIR)) return;
  const tasks = {};
  try {
    fs.readdirSync(TASKS_DIR).forEach(project => {
      const projDir = path.join(TASKS_DIR, project);
      let stat;
      try { stat = fs.statSync(projDir); } catch { return; }
      if (!stat.isDirectory()) return;

      tasks[project] = [];
      try {
        fs.readdirSync(projDir)
          .filter(f => f.endsWith('.json'))
          .forEach(f => {
            const task = readJson(path.join(projDir, f));
            if (task) tasks[project].push(task);
          });
      } catch {}
    });
  } catch {}
  state.tasks = tasks;
  broadcast('tasks', tasks);
}

function readStats() {
  if (!fs.existsSync(STATS_FILE)) return;
  const stats = readJson(STATS_FILE);
  if (stats) {
    state.stats = stats;
    broadcast('stats', stats);
  }
}

// ─── tmux polling ────────────────────────────────────────────────────────────

function captureTmuxPane(paneId, agentId, teamName) {
  if (!paneId) return;
  // Sanitize paneId to prevent injection (allow %digits or window.pane format)
  if (!/^[%\w:.]+$/.test(paneId)) return;
  exec(`tmux capture-pane -t ${paneId} -p -S -80 2>/dev/null`, (err, stdout) => {
    if (err) return;
    if (state.tmuxOutputs[agentId] !== stdout) {
      state.tmuxOutputs[agentId] = stdout;
      broadcast('tmux', { agentId, teamName, lines: stdout });
    }
  });
}

function pollAllTmux() {
  Object.values(state.teams).forEach(team => {
    if (!Array.isArray(team.members)) return;
    team.members.forEach(member => {
      if (member.tmuxPaneId) {
        captureTmuxPane(member.tmuxPaneId, member.agentId, team.name);
      }
    });
  });
}

// ─── File watchers ───────────────────────────────────────────────────────────

function setupWatchers() {
  const watchOpts = { depth: 2, ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 200 } };

  if (fs.existsSync(TEAMS_DIR)) {
    chokidar.watch(TEAMS_DIR, watchOpts).on('all', (event, filePath) => {
      if (filePath.endsWith('config.json')) {
        setTimeout(readTeams, 150);
      } else if (filePath.endsWith('messages.json')) {
        const teamName = path.basename(path.dirname(filePath));
        setTimeout(() => readMessages(teamName), 150);
      }
    });
  }

  if (fs.existsSync(TASKS_DIR)) {
    chokidar.watch(TASKS_DIR, watchOpts).on('all', () => setTimeout(readTasks, 150));
  }
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

wss.on('connection', ws => {
  // Send full state snapshot on connect
  ws.send(JSON.stringify({ type: 'snapshot', data: state, ts: Date.now() }));

  ws.on('message', raw => {
    try {
      const { action, payload } = JSON.parse(raw);
      if (action === 'captureTmux') {
        const { paneId, agentId, teamName } = payload;
        if (paneId && agentId && !/[^%\w:.]/.test(paneId)) {
          exec(`tmux capture-pane -t ${paneId} -p -S -200 2>/dev/null`, (err, stdout) => {
            if (!err) {
              ws.send(JSON.stringify({ type: 'tmux', data: { agentId, teamName, lines: stdout }, ts: Date.now() }));
            }
          });
        }
      }
    } catch {}
  });
});

// ─── Plugin scanner ───────────────────────────────────────────────────────────

const PLUGINS_CACHE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'cache');
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  match[1].split('\n').forEach(line => {
    const m = line.match(/^(\w[\w-]*):\s*"?(.+?)"?\s*$/);
    if (m) result[m[1]] = m[2];
  });
  return result;
}

function scanPlugins() {
  const commands = [];
  const agents = [];
  if (!fs.existsSync(PLUGINS_CACHE_DIR)) return { commands, agents };

  try {
    const marketplaces = fs.readdirSync(PLUGINS_CACHE_DIR);
    marketplaces.forEach(marketplace => {
      const mDir = path.join(PLUGINS_CACHE_DIR, marketplace);
      if (!fs.statSync(mDir).isDirectory()) return;

      fs.readdirSync(mDir).forEach(pluginName => {
        const pDir = path.join(mDir, pluginName);
        if (!fs.statSync(pDir).isDirectory()) return;

        // Get latest version
        const versions = fs.readdirSync(pDir).filter(v => /^\d/.test(v)).sort().reverse();
        if (versions.length === 0) return;
        const vDir = path.join(pDir, versions[0]);

        // Scan commands/*.md
        const cmdDir = path.join(vDir, 'commands');
        if (fs.existsSync(cmdDir)) {
          fs.readdirSync(cmdDir).filter(f => f.endsWith('.md')).forEach(f => {
            try {
              const fm = parseFrontmatter(fs.readFileSync(path.join(cmdDir, f), 'utf8'));
              const cmdName = f.replace('.md', '');
              if (fm.description) {
                commands.push({
                  plugin: pluginName,
                  command: `/${pluginName}:${cmdName}`,
                  name: fm.name || cmdName,
                  description: fm.description
                });
              }
            } catch {}
          });
        }

        // Scan skills/*/SKILL.md
        const skillsDir = path.join(vDir, 'skills');
        if (fs.existsSync(skillsDir)) {
          fs.readdirSync(skillsDir).forEach(skillName => {
            const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
            if (!fs.existsSync(skillFile)) return;
            try {
              const fm = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
              if (fm.description) {
                commands.push({
                  plugin: pluginName,
                  command: `/${pluginName}:${skillName}`,
                  name: fm.name || skillName,
                  description: fm.description,
                  aliases: fm.aliases || ''
                });
              }
            } catch {}
          });
        }

        // Scan agents/
        const agentDir = path.join(vDir, 'agents');
        if (fs.existsSync(agentDir)) {
          fs.readdirSync(agentDir).filter(f => f.endsWith('.md')).forEach(f => {
            try {
              const fm = parseFrontmatter(fs.readFileSync(path.join(agentDir, f), 'utf8'));
              if (fm.description) {
                agents.push({
                  plugin: pluginName,
                  name: fm.name || f.replace('.md', ''),
                  description: fm.description,
                  model: fm.model || ''
                });
              }
            } catch {}
          });
        }
      });
    });
  } catch {}

  // Scan ~/.claude/skills/ (global skills)
  if (fs.existsSync(SKILLS_DIR)) {
    try {
      fs.readdirSync(SKILLS_DIR).forEach(skillName => {
        const skillFile = path.join(SKILLS_DIR, skillName, 'SKILL.md');
        if (!fs.existsSync(skillFile)) return;
        try {
          const fm = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
          if (fm.description) {
            commands.push({
              plugin: fm.source ? fm.source.split(' ')[0] : 'skills',
              command: `/${skillName}`,
              name: fm.name || skillName,
              description: fm.description
            });
          }
        } catch {}
      });
    } catch {}
  }

  return { commands, agents };
}

// ─── REST API ────────────────────────────────────────────────────────────────

app.get('/api/plugins', (req, res) => res.json(scanPlugins()));
app.get('/api/state', (req, res) => res.json(state));
app.get('/api/teams', (req, res) => res.json(state.teams));
app.get('/api/tasks', (req, res) => res.json(state.tasks));
app.get('/api/stats', (req, res) => res.json(state.stats));

app.post('/api/refresh', (req, res) => {
  readTeams();
  readTasks();
  readStats();
  readAllMessages();
  broadcast('snapshot', state);
  res.json({ ok: true });
});

app.delete('/api/teams/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const teamDir = path.join(TEAMS_DIR, name);
  try {
    if (fs.existsSync(teamDir)) {
      fs.rmSync(teamDir, { recursive: true, force: true });
    }
    delete state.teams[name];
    delete state.messages[name];
    broadcast('teams', state.teams);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────────

readTeams();
readTasks();
readStats();
readAllMessages();
setupWatchers();

setInterval(pollAllTmux, 2000);
setInterval(readStats, 5000);

server.listen(PORT, () => {
  console.log(`Claude Team Monitor → http://localhost:${PORT}`);
  console.log(`Claude dir: ${CLAUDE_DIR}`);
});
