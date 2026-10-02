export interface WebBrowserSource { id: string; name: string; url: string }
export interface WebBrowserSourceInput { id?: string; name?: string; url: string }
export interface WebBrowserApi {
  list(): Promise<WebBrowserSource[]>
  save(input: WebBrowserSourceInput): Promise<WebBrowserSource>
  remove(id: string): Promise<void>
  open(url: string): Promise<string>
  onEdit(callback: (url: string) => void): () => void
}
