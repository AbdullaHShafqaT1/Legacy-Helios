
      const Database = require('better-sqlite3');
      const db = new Database('memory-store/resumption-real-test.db');
      // Update heartbeat to be stale (10 mins ago) to simulate a crash that happened in the past
      const past = new Date(Date.now() - 600000).toISOString();
      db.prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?').run(past, 'task-real-restart');
      db.close();
      process.exit(0);
    