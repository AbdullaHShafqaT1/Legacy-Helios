const fs = require('fs');
const glob = require('glob');
const files = glob.sync('core/test/**/*.ts');
for (const f of files) {
  let content = fs.readFileSync(f, 'utf8');
  content = content.replace(/actor: 'software-engineer'/g, "actor: 'software-engineer' as any");
  content = content.replace(/actor: 'researcher'/g, "actor: 'researcher' as any");
  content = content.replace(/actor: 'unregistered-agent'/g, "actor: 'unregistered-agent' as any");
  content = content.replace(/actor: 'cli'/g, "actor: 'cli' as any");
  content = content.replace(/actor: 'terminal-operator'/g, "actor: 'terminal-operator' as any");
  content = content.replace(/sender: 'researcher'/g, "sender: 'researcher' as any");
  content = content.replace(/actor: 'test-actor'/g, "actor: 'test-actor' as any");
  content = content.replace(/sender: 'looper-agent'/g, "sender: 'looper-agent' as any");
  fs.writeFileSync(f, content);
}
