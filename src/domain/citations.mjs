// Remove personal note fields from bibliography exports without changing citekeys
// or quoted/braced bibliographic values. Full reading-material export is separate.
export function bibliographyOnly(text, format) {
  if(format==='ris'){
    let skip=false;
    return text.split(/\r?\n/).filter(line=>{const tag=/^([A-Z0-9]{2})  - /.exec(line);if(tag)skip=['N1','L1','L2','L4'].includes(tag[1]);return !skip;}).join('\n');
  }
  if(format==='csljson'){
    const rows=JSON.parse(text);if(!Array.isArray(rows))throw new Error('Unexpected CSL JSON export');
    return JSON.stringify(rows.map(row=>{const {note,annote,notes,attachments,...fields}=row;return fields;}),null,2);
  }
  if(!['bibtex','biblatex'].includes(format))return text;
  let result='',cursor=0,depth=0,quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='\\'){i++;continue;}
    if(c==='"'&&depth===1){quoted=!quoted;continue;}
    if(quoted)continue;
    if(c==='{'){depth++;continue;}
    if(c==='}'){depth--;continue;}
    if(c!==','||depth!==1)continue;
    const match=/^,\s*(?:annote|note|file)\s*=\s*/i.exec(text.slice(i));
    if(!match)continue;
    let end=i+match[0].length,nested=0,inQuote=false;
    for(;end<text.length;end++) {
      const v=text[end];if(v==='\\'){end++;continue;}
      if(v==='"'&&nested===0)inQuote=!inQuote;
      if(!inQuote){if(v==='{')nested++;else if(v==='}'){if(nested===0)break;nested--;}}
      if(v===','&&nested===0&&!inQuote)break;
    }
    result+=text.slice(cursor,i);cursor=end;i=end-1;
  }
  return result+text.slice(cursor);
}
