// ╔══════════════════════════════════════════════════════════╗
// ║       SPADE CHKR BOT - proxy.js v2.0 @ZeroSpade        ║
// ║      Not Editable Kidzz!!    ║
// ╚══════════════════════════════════════════════════════════╝

(function(){
const _k="ZeroSpadeChkrBotSecretKeyV2xX9!#@";
const _bc="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

function _b64d(s){
  s=s.replace(/[^A-Za-z0-9\+\/\=]/g,"");
  let o="",i=0,b0,b1,b2,b3,c1,c2,c3;
  while(i<s.length){
    b0=_bc.indexOf(s.charAt(i++));b1=_bc.indexOf(s.charAt(i++));
    b2=_bc.indexOf(s.charAt(i++));b3=_bc.indexOf(s.charAt(i++));
    c1=(b0<<2)|(b1>>4);c2=((b1&15)<<4)|(b2>>2);c3=((b2&3)<<6)|b3;
    o+=String.fromCharCode(c1);
    if(b2!==64)o+=String.fromCharCode(c2);
    if(b3!==64)o+=String.fromCharCode(c3);
  }
  return o;
}

function _xd(enc,key){
  const raw=_b64d(enc);let o="";
  for(let i=0;i<raw.length;i++){
    o+=String.fromCharCode(raw.charCodeAt(i)^key.charCodeAt(i%key.length));
  }
  return o;
}

function _chk(n,s){
  let t=0;
  for(let i=0;i<s.length;i++)t=((t*31+s.charCodeAt(i))>>>0);
  return t===n;
}

if(!_chk(29852818,_k)){
  process.stderr.write("\x1b[31m[FATAL] Integrity check failed.\x1b[0m\n");
  process.exit(1);
}

const _D=[
    "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"
];

try{
  const _src=_xd(_D.join(""),_k);
  const _mod={exports:{}};
  (new Function("require","module","exports",_src))(require,_mod,_mod.exports);
  module.exports=_mod.exports;
}catch(_e){
  process.stderr.write("\x1b[31m[ERROR] "+_e.message+"\x1b[0m\n");
  process.exit(1);
}
})();