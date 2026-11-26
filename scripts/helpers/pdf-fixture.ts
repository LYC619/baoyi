/** Small, real one-page PDF used by isolated parser/model acceptance tests. */
export function textPdf(text='Evidence belongs to a source page.') {
  const stream=`BT /F1 18 Tf 50 740 Td (${text}) Tj ET`,objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let source='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${o}\nendobj\n`});const xref=Buffer.byteLength(source)
  return source+`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
}

/** Compact two-page fixture, with selectable lines on both sides of the page boundary. */
export function crossPagePdf() {
  const streams=['BT /F1 18 Tf 50 40 Td (First page ending evidence.) Tj ET','BT /F1 18 Tf 50 800 Td (Second page continuing evidence.) Tj ET']
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',...streams.map((_,i)=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents ${6+i} 0 R >>`),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',...streams.map(s=>`<< /Length ${s.length} >>\nstream\n${s}\nendstream`)]
  let source='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${o}\nendobj\n`});const xref=Buffer.byteLength(source)
  return source+`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
}

/** Native bookmarks include a named destination, a container and a broken target. */
export function outlinePdf(pageCount=3, withOutline=true, title='Research notebook',body?:(page:number)=>string[]) {
  const pageIds=Array.from({length:pageCount},(_,i)=>3+i)
  const font=3+pageCount,contents=font+1,outline=contents+pageCount
  const escaped=title.replace(/[\\()]/g,'\\$&')
  const streams=pageIds.map((_,i)=>`0.10 0.35 0.38 rg 40 680 515 120 re f\n1 1 1 rg BT /F1 26 Tf 60 750 Td (${escaped}) Tj 0 -42 Td (Page ${i+1}) Tj ET\n0 0 0 rg BT /F1 14 Tf 50 600 Td ${(body?.(i+1)||[`Evidence belongs to chapter ${i+1}.`]).map(line=>'('+line.replace(/[\\()]/g,'\\$&')+') Tj 0 -24 Td').join(' ')} ET`)
  const objects=[`<< /Type /Catalog /Pages 2 0 R ${withOutline?`/Outlines ${outline} 0 R /Names << /Dests << /Names [(chapter-two) [${pageIds[1]||3} 0 R /Fit]] >> >>`:''} >>`,
    `<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageIds.map((_,i)=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents+i} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(s=>`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`)]
  if(withOutline) objects.push(
    `<< /Type /Outlines /First ${outline+1} 0 R /Last ${outline+4} 0 R /Count 5 >>`,
    `<< /Title (Chapter one) /Parent ${outline} 0 R /Dest [3 0 R /Fit] /Next ${outline+2} 0 R >>`,
    `<< /Title (Chapter two) /Parent ${outline} 0 R /Dest (chapter-two) /Prev ${outline+1} 0 R /Next ${outline+3} 0 R /First ${outline+5} 0 R /Last ${outline+5} 0 R /Count 1 >>`,
    `<< /Title (Container only) /Parent ${outline} 0 R /Prev ${outline+2} 0 R /Next ${outline+4} 0 R /First ${outline+6} 0 R /Last ${outline+6} 0 R /Count 1 >>`,
    `<< /Title (Broken target) /Parent ${outline} 0 R /Prev ${outline+3} 0 R /Dest (does-not-exist) >>`,
    `<< /Title (Nested section) /Parent ${outline+2} 0 R /Dest [${pageIds[2]||3} 0 R /Fit] >>`,
    `<< /Title (Container section) /Parent ${outline+3} 0 R /Dest [${pageIds[2]||3} 0 R /Fit] >>`)
  let source='%PDF-1.7\n';const offsets=[0]
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${o}\nendobj\n`})
  const xref=Buffer.byteLength(source)
  return source+`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
}
