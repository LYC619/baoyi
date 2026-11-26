const fs=require('node:fs')
const file='src/pages/document/Home.vue'
let source=fs.readFileSync(file,'utf8')
const start=source.indexOf('<template>'),end=source.lastIndexOf('</template>')+'</template>'.length
const template=`<template>
  <main class="ws ws-layout document-home">
    <aside class="ws-sidebar">
      <h2>资料分类</h2>
      <button :class="{active:!store.type}" @click="store.type=''">全部<span>{{store.items.length}}</span></button>
      <button v-for="category in store.categories" :key="category.id" :class="{active:store.type===category.id}" @click="store.type=category.id">{{category.name}}<span>{{store.items.filter(i=>i.type===category.id).length}}</span></button>
      <hr/>
      <h2>阅读状态</h2>
      <button :class="{active:!store.state}" @click="store.state=''">不限</button>
      <button v-for="(label,key) in reading" :key="key" :class="{active:store.state===key}" @click="store.state=key">{{label}}<span>{{store.items.filter(i=>i.readable&&i.readState===key).length}}</span></button>
      <hr/>
      <h2>标签</h2>
      <div class="document-tags" aria-label="筛选资料标签">
        <button class="tag-pill" :class="{active:!store.tag}" :aria-pressed="!store.tag" @click="store.tag=''">全部标签<span>{{baseRows.length}}</span></button>
        <button v-for="tag in tags" :key="tag.name" class="tag-pill" :class="{active:store.tag===tag.name}" :aria-pressed="store.tag===tag.name" :title="tag.name" @click="store.tag=tag.name">{{tag.name}}<span>{{tag.count}}</span></button>
      </div>
      <button class="ws-settings" @click="router.push('/settings?module=document&tab=document')"><Settings :size="15"/>设置</button>
      <small>知止而后得</small>
    </aside>
    <section ref="main" class="ws-main">
      <header class="ws-header">
        <div><h1>资料 <small>{{rows.length}} 份</small></h1><p class="ws-muted">阅读、留存，以及再次用到它们。</p></div>
        <DocumentAssistant :context="{documentIds:store.selected?[store.selected]:[]}" @opened="assistantOpened"/>
        <button ref="detailTrigger" class="ws-icon" :aria-label="details?'收起资料详情':'展开资料详情'" :aria-expanded="details" @click="details?closeDetails():details=true"><PanelRightClose v-if="details" :size="20"/><PanelRightOpen v-else :size="20"/></button>
      </header>
      <input v-model="store.search" type="search" aria-label="搜索资料" placeholder="搜索标题、作者、相关方、备注或标签…"/>
      <div class="ws-toolbar">
        <select v-model="store.sort" aria-label="资料排序"><option value="updated">最近阅读 / 更新</option><option value="name">按名称</option></select>
        <span class="ws-spacer"/>
        <div class="ws-tabs">
          <button :class="{active:store.view==='list'}" aria-label="列表视图" @click="store.view='list'"><List :size="16"/></button>
          <button :class="{active:store.view==='grid'}" aria-label="书架视图" @click="store.view='grid'"><Grid2X2 :size="16"/></button>
        </div>
        <button class="ws-button" :disabled="busy" @click="scan(true)"><FolderSearch :size="15"/>扫描目录</button>
        <button class="ws-button primary" :disabled="busy" @click="scan(false)"><Plus :size="15"/>导入</button>
      </div>
      <p v-if="error||store.error" class="ws-error" role="alert">{{error||store.error}}</p>
      <div v-if="!rows.length" class="ws-empty">
        <BookOpen :size="36"/><h2>{{store.items.length?'没有匹配的资料':'为下一次思考，留一份资料'}}</h2>
        <p>导入书籍、论文、合同或证书。文件保留在原位置，笔记与关联由抱一记住。</p>
        <button class="ws-button primary" :disabled="busy" @click="scan(false)">选择资料文件</button>
      </div>
      <section v-for="section in sections" :key="section.title" class="document-section">
        <h2>{{section.title}}</h2>
        <div class="document-list" :class="{'document-grid':store.view==='grid'}">
          <article v-for="item in section.items" :key="item.id" class="document-row" :class="{selected:store.selected===item.id}" tabindex="0" :aria-label="item.name" @click="store.selected=item.id;details=true" @dblclick="open(item)" @keydown.enter.self="open(item)" @keydown.space.prevent.self="store.selected=item.id;details=true">
            <DocumentCover :item="item" :size="store.view==='grid'?'grid':'list'"/>
            <div class="document-row-info">
              <strong>{{item.name}} <span class="ws-badge">{{item.typeName}}</span></strong>
              <small>{{item.readable?(item.author||item.typeName):(item.counterpart||item.typeName)}}<template v-if="item.expiresOn"> · 有效期至 {{item.expiresOn}}</template></small>
              <span v-if="item.tags.length" class="row-tags ws-muted">{{item.tags.join(' · ')}}</span>
            </div>
            <div class="document-row-state">
              <DocumentProgress :item="item"/>
              <span v-if="counts.get(item.id)" class="ws-badge project-count">被 {{counts.get(item.id)}} 个项目引用</span>
              <small v-if="!item.available">文件暂不可用</small>
            </div>
            <button class="ws-icon row-open" :aria-label="(item.readable?'阅读 ':'查看 ')+item.name" @click.stop="open(item)">›</button>
          </article>
        </div>
      </section>
    </section>
    <aside v-if="details" class="document-inspector" aria-label="资料详情" @keydown.esc.stop="closeDetails">
      <button class="ws-icon inspector-close" aria-label="关闭资料详情" @click="closeDetails">×</button>
      <template v-if="current">
        <DocumentCover :item="current" size="detail"/>
        <h2>{{current.name}}</h2>
        <p class="ws-muted">{{current.typeName}} · {{current.author||current.counterpart||current.format.toUpperCase()}}</p>
        <p class="ws-path">{{current.path}}</p>
        <DocumentProgress :item="current"/>
        <p v-if="counts.get(current.id)"><span class="ws-badge">被 {{counts.get(current.id)}} 个项目引用</span></p>
        <p v-if="current.expiresOn" class="ws-muted">有效期至 {{current.expiresOn}}</p>
        <p v-if="current.issuedOn" class="ws-muted">取得 / 发布：{{current.issuedOn}}</p>
        <button class="ws-button primary document-open" @click="open(current)"><BookOpen :size="16"/>{{current.readable?(current.readState==='unread'?'开始阅读':'继续阅读'):'查看文件 / 凭证'}}</button>
        <div class="ws-toolbar">
          <button class="ws-button" @click="editing=true"><Pencil :size="14"/>编辑</button>
          <button class="ws-icon" aria-label="定位资料文件" @click="run(()=>workspace.documents.reveal(current!.id))"><FolderOpen :size="16"/></button>
          <button v-if="!current.available" class="ws-button" :disabled="busy" @click="run(()=>workspace.documents.relocate(current!.id))">重新定位</button>
        </div>
        <p class="ws-muted">书签 {{annotations.filter(a=>a.kind==='bookmark').length}} 个 · 摘录 {{annotations.filter(a=>a.kind==='excerpt').length}} 条</p>
        <p v-if="current.notes" class="ws-pre">{{current.notes}}</p>
        <section class="ws-links">
          <h3>用于这些事</h3><p v-if="!backlinks.length" class="ws-muted">尚未被项目或个人记录引用。</p>
          <button v-for="b in backlinks" :key="b.ownerType+b.ownerId" class="document-backlink" @click="router.push(ownerPath(b))">{{b.name}} <span class="ws-muted">{{b.ownerType==='project'?'项目':b.ownerType==='event'?'项目记录':'个人记录'}}</span></button>
        </section>
        <button class="ws-button danger" :disabled="busy" @click="remove">移除资料索引</button>
      </template>
      <div v-else class="ws-empty"><FileText :size="28"/><p>选择一份资料，查看详情与关联。</p></div>
    </aside>
    <DocumentRemove v-if="removing&&current" :id="current.id" @close="removing=false" @removed="store.selected='';store.refresh()"/>
    <DocumentEdit v-if="editing&&current" :item="current" @close="editing=false" @saved="store.refresh"/>
    <ProjectDialog v-if="preview" title="导入资料预览" wide :busy="busy" @close="preview=null">
      <div class="ws">
        <p class="ws-muted">已找到 {{preview.items.length}} 份资料，已登记的文件会跳过。</p>
        <p v-for="warning in preview.warnings" :key="warning" class="ws-notice">{{warning}}</p><p v-if="error" class="ws-error">{{error}}</p>
        <label class="import-category">导入分类<select v-model="preview.categoryId" aria-label="导入分类" :disabled="busy"><option value="">暂不指定（先放入其他，可让助手整理）</option><option v-for="category in store.categories" :key="category.id" :value="category.id">{{category.name}}</option></select></label>
        <p class="ws-muted">明确选择的分类将保留，助手不会自动覆盖。</p>
        <div class="document-import"><label v-for="candidate in preview.items" :key="candidate.path"><input v-model="selectedPaths" type="checkbox" :value="candidate.path" :disabled="candidate.existing||busy"/><span>{{candidate.name}} <small>{{candidate.existing?'已登记':''}}</small><span class="ws-path">{{candidate.path}}</span></span></label></div>
      </div>
      <template #footer><div class="ws"><button class="ws-button primary" :disabled="busy||!selectedPaths.length" @click="importFiles">导入所选 {{selectedPaths.length}} 份资料</button></div></template>
    </ProjectDialog>
  </main>
</template>`
source=source.slice(0,start)+template+source.slice(end)
source=source.replace(/<style scoped>[\s\S]*?<\/style>/,`<style scoped>
.document-home{position:relative}
.document-section{margin-top:24px}.document-section h2{font-size:16px;margin-bottom:10px}
.document-list{border-top:1px solid var(--divider)}
.document-row{display:flex;gap:15px;align-items:center;text-align:left;width:100%;padding:14px 10px;border-bottom:1px solid var(--divider);color:var(--text-main);cursor:pointer}
.document-row:hover,.document-row.selected{background:var(--ws-tint)}.document-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.document-row-info{flex:1;min-width:0}.document-row strong{display:block;overflow-wrap:anywhere;font-size:14px;font-weight:500;line-height:1.6}.document-row strong .ws-badge{vertical-align:middle;margin-left:5px}
.document-row-info small,.document-row-state>small{display:block;margin-top:6px;font-size:12px;color:var(--text-sub)}.row-tags{display:block;margin-top:5px;font-size:11px}
.document-row-state{flex:0 0 150px;min-width:0}.project-count{margin-top:7px;color:var(--accent)}.row-open{font-size:24px;width:22px}
.document-grid{border:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px}
.document-grid .document-row{position:relative;align-items:stretch;flex-direction:column;gap:13px;border:1px solid var(--divider);border-radius:6px;padding:16px}
.document-grid .document-row-info{width:100%}.document-grid .document-row-state{flex:none;width:100%;margin-top:auto}.document-grid .row-open{position:absolute;right:6px;top:5px}
.document-inspector{position:relative;flex:0 0 290px;padding:30px 24px;overflow:auto;border-left:1px solid var(--divider)}.inspector-close{position:absolute;right:4px;top:4px}
.document-inspector h2{overflow-wrap:anywhere;font-size:20px;line-height:1.6;margin-top:20px}.document-open{width:100%;margin-top:15px}.document-backlink{display:block;text-align:left;padding:10px 0;width:100%;border-bottom:1px solid var(--divider);color:var(--text-main)}.document-inspector>.danger{margin-top:24px;font-size:12px}
.document-tags{display:flex;flex-direction:column;align-items:flex-start;gap:8px;max-height:260px;overflow:auto}.document-tags .tag-pill{max-width:100%;border:1px solid var(--divider);border-radius:18px;padding:5px 10px;font-size:12px;overflow-wrap:anywhere;white-space:normal}.tag-pill span{flex:none;padding-left:5px}
.document-import{max-height:50vh;overflow:auto}.document-import label{display:flex;gap:10px;padding:10px;border-bottom:1px solid var(--divider)}.document-import .ws-path{display:block}.document-import input{flex:none}.document-import small{color:var(--accent)}
@media(max-width:1100px){.document-inspector{flex-basis:240px;padding:25px 16px}.document-row-state{flex-basis:120px}.document-row{gap:9px;padding:14px 5px}.document-home .ws-main{padding:22px 18px}.document-grid{grid-template-columns:repeat(auto-fill,minmax(175px,1fr))}}
@media(max-width:860px){.document-inspector{position:absolute;right:0;top:0;bottom:0;background:var(--bg-main);width:min(290px,calc(100% - 24px));z-index:10;box-shadow:-10px 0 30px #0002}.document-home .ws-sidebar{flex-basis:140px}.document-home .ws-main{padding:20px 16px}.document-row-state{flex-basis:125px}.document-grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}}
</style>`)
fs.writeFileSync(file,source)
