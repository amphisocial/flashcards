// PM2 process definition for Athena Flashcards.
// Usage: pm2 start deploy/ecosystem.config.js --env production
module.exports = {
  apps: [
    {
      name: 'flashcards',
      script: 'server/server.js',
      cwd: '/opt/apps/flashcards',
      // .env is loaded by the app itself (make sure server/server.js or its
      // config module calls require('dotenv').config() — see note below).
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/opt/apps/flashcards/logs/error.log',
      out_file: '/opt/apps/flashcards/logs/out.log',
      time: true
    }
  ]
};
