// Only explicitly supplied creator fields may enter signed/public provenance.
export function validCreator(creator){
 if(!creator||typeof creator!=='object'||Array.isArray(creator))return false;
 const keys=Object.keys(creator);if(!keys.length||keys.some(k=>!['name','organization','orcid'].includes(k)))return false;
 for(const key of keys){const value=creator[key];if(typeof value!=='string'||!value.length||value.length>160||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value))return false;}
 if(creator.orcid){if(!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(creator.orcid))return false;const digits=creator.orcid.replaceAll('-','');let total=0;for(const d of digits.slice(0,15))total=(total+Number(d))*2;const check=(12-total%11)%11;if(digits[15]!== (check===10?'X':String(check)))return false;}
 return true;
}
export function projectCreator(creator){return validCreator(creator)?Object.fromEntries(['name','organization','orcid'].filter(k=>creator[k]).map(k=>[k,creator[k]])):undefined;}
