// Builds wrapt-documents.html from tools/wrapt-documents.template.html by embedding
// the agreement builder and payout form as JSON strings. Run: node tools/build-wrapt-documents.js
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const tpl=fs.readFileSync(path.join(__dirname,'wrapt-documents.template.html'),'utf8');
const embed=f=>JSON.stringify(fs.readFileSync(path.join(root,'agreements',f),'utf8')).replace(/<\/script/gi,'<\\/script').replace(/<!--/g,'<\\u0021--');
const out=tpl.replace('__AGREEMENT_TPL__',()=>embed('wrapt-agreement-builder.html')).replace('__PAYOUT_TPL__',()=>embed('wrapt-payout-setup.html'));
fs.writeFileSync(path.join(root,'wrapt-documents.html'),out);
console.log('wrote wrapt-documents.html',(out.length/1024).toFixed(0)+'KB');
