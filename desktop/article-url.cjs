const net=require('node:net');
const dns=require('node:dns').promises;
const forbidden=new net.BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])forbidden.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['::',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]])forbidden.addSubnet(address,prefix,'ipv6');
forbidden.addAddress('::1','ipv6');
function publicURL(raw){
  try{const u=new URL(raw),host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
    if(!['http:','https:','ws:','wss:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port)||!host||host==='localhost'||/\.(localhost|local|internal)$/.test(host))return false;
    const version=net.isIP(host);if(version&&(forbidden.check(host,version===6?'ipv6':'ipv4')||/^198\.(18|19)\./.test(host)))return false;
    return true;
  }catch{return false;}
}
async function publicRequest(raw,lookup=dns.lookup){
  if(!publicURL(raw))return false;
  const u=new URL(raw),host=u.hostname.replace(/^\[|\]$/g,'');if(net.isIP(host))return true;
  try{const addresses=await lookup(host,{all:true});return addresses.length>0&&addresses.every(({address,family})=>!forbidden.check(address,family===6?'ipv6':'ipv4')&&(!/^198\.(18|19)\./.test(address)||['https:','wss:'].includes(u.protocol)));}catch{return false;}
}
module.exports={publicURL,publicRequest};
