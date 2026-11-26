const fs=require('node:fs')
function edit(file,replacements){let text=fs.readFileSync(file,'utf8');for(const [from,to]of replacements){if(!text.includes(from))throw Error('Missing target in '+file);text=text.replace(from,to)}fs.writeFileSync(file,text)}
edit('src/pages/image/Home.vue',[
 [':view="photoView" class="image-photo-toolbar"',':view="photoView" :single-only="categoryPhotos&&!manageAlbums" class="image-photo-toolbar"'],
 ["photoView.display==='single'","galleryView.display==='single'"],
 [':view="photoView" :query-key="JSON.stringify(store.query)" @manage="photoView.display=\'albums\'"',':view="galleryView" :query-key="JSON.stringify(store.query)" @manage="manage"']
])
edit('src/components/image/PhotoGallery.vue',[
 ['{{total}} 张图片 · {{items.size}} 个组合','{{total}} 张图片<span v-if="items.size>1"> · {{items.size}} 个文件夹</span>'],
 ['<section v-for="block in blocks"', '<p v-if="!busy&&!error&&!total" class="im-empty">文件夹中暂无图片，放入新图片后会自动显示。</p>\n    <section v-for="block in blocks"'],
 [':page-id="p.id" :name="p.name"',':page-id="p.id" :revision="items.get(p.resourceId)?.updatedAt" :name="p.name"']
])
edit('src/components/video/VideoRemovalDialog.vue',[
 ["共享文件会保留；已缺失的文件无需处理。","同时清理归属已核实的抱一清单、备份与生成资料，并移除空目录。共享文件和用户修改过的资料会保留。"],
 ["file.shared ? '共享，保留'", "file.preserveReason || (file.shared ? '共享，保留'"],
 ["'保留文件' }}", "'保留文件') }}"]
])
edit('src/components/settings/ImageSettings.vue',[
 ['<template v-if="section === \'tags\'">','<p v-if="section===\'scan\'&&type!==\'comic\'" class="ws-muted">已导入的本地文件夹自动更新：放入、替换或移除图片后，等待文件稳定即可显示；启动时也会补扫。软件关闭期间无需保持运行。磁盘离线时保留索引；新文件夹仍需先导入。</p>\n      <template v-if="section === \'tags\'">']
])
