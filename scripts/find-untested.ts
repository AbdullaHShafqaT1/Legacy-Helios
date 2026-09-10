import fs from 'fs';
import path from 'path';

function getFiles(dir: string, ext: string, fileList: string[] = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            getFiles(filePath, ext, fileList);
        } else if (filePath.endsWith(ext)) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

const srcFiles = getFiles('core/src', '.ts').filter(f => !f.endsWith('.d.ts'));
const testFiles = getFiles('core/test', '.test.ts');

const srcBasenames = srcFiles.map(f => path.basename(f, '.ts'));
const testBasenames = testFiles.map(f => path.basename(f, '.test.ts'));

const untested = srcBasenames.filter(b => !testBasenames.includes(b) && b !== 'index' && b !== 'bootstrap' && b !== 'orchestrator');

console.log('Total src files:', srcFiles.length);
console.log('Total test files:', testFiles.length);
console.log('Untested basenames:', untested);
