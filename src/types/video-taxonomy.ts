export interface VideoTaxonomy {
  groups: Array<{ name: string; count: number }>
  tags: Array<{ name: string; count: number }>
  works: Array<{ id: string; name: string }>
}
export interface VideoTaxonomyEdit {
  hentai: boolean
  field: 'groups' | 'tags'
  from: string | null
  to: string | null
  ids?: string[]
}
