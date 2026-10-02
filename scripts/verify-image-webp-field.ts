import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { initSchema } from '../electron/services/schema.ts'
import { KINDS } from '../electron/kinds/index.ts'
import { ImageLibrary } from '../electron/kinds/image/library.ts'
import { scanImageImport } from '../electron/kinds/image/scanner.ts'
import { readImagePage } from '../electron/kinds/image/files.ts'
import { inspectImage } from '../electron/kinds/image/metadata.ts'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'baoyi-webp-')),db=new DatabaseSync(':memory:')
try{
 initSchema(db,KINDS)
 const bytes=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')
 await fs.writeFile(path.join(root,'1.webp'),bytes);await fs.writeFile(path.join(root,'2.jpg'),bytes)
 const library=new ImageLibrary(db),item=library.register((await scanImageImport(root,'comic',false))[0])
 assert.equal(item.pageCount,2)
 for(const page of library.pages(item.id)){const data=await readImagePage(db,page.id);assert.equal(data.mime,'image/webp');assert.equal(inspectImage(data.data).width,1)}
 console.log('PASS local WebP and WebP data behind legacy JPG filenames')
}finally{db.close();await fs.rm(root,{recursive:true,force:true})}
