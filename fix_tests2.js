const fs = require('fs');
const glob = require('glob');
const files = glob.sync('core/test/**/*.ts');

for (const f of files) {
  let content = fs.readFileSync(f, 'utf8');
  content = content.replace(/actor: '([^']+)'/g, "actor: '$1' as any");
  content = content.replace(/sender: '([^']+)'/g, "sender: '$1' as any");
  content = content.replace(/actingOnBehalfOf: '([^']+)'/g, "actingOnBehalfOf: '$1' as any");
  content = content.replace(/@ts-expect-error - 'invalid-role' is not a valid AgentRole/g, "");
  fs.writeFileSync(f, content);
}
