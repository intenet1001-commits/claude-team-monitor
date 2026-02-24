module.exports = {
  apps: [{
    name: 'claude-team-monitor',
    script: 'server.js',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    env: {
      PORT: 9099,
      CLAUDE_DIR: '/Users/gwanli/.claude'
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
