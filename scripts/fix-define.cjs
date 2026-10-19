const fs = require('fs');
const p='src/scripts/check-companions-voice.ts';
let s=fs.readFileSync(p,'utf8');
const from="  window.SpeechSynthesisUtterance = Utterance;\n  window.speechSynthesis = {";
const to="  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });\n  const synthMock = {";
if(!s.includes(from)){console.error('missing');process.exit(1);}
s=s.replace(from,to);
const from2="  };\n  class FakeSR {";
const to2="  };\n  Object.defineProperty(window, 'speechSynthesis', { value: synthMock, configurable: true });\n  class FakeSR {";
if(!s.includes(from2)){console.error('missing2');process.exit(1);}
s=s.replace(from2,to2);
fs.writeFileSync(p,s);console.log('defineProperty applied');
