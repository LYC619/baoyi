import type { ObjectDirective } from 'vue'
// Measure cards themselves, never the grid area: changing the span must not
// stretch the observed box or trigger a ResizeObserver feedback loop.
const entries=new WeakMap<HTMLElement,{observer:ResizeObserver;active:boolean;resize:()=>void}>()
export const vMasonry:ObjectDirective<HTMLElement,boolean>={
  mounted(element,binding){
    const state={active:binding.value,observer:null as unknown as ResizeObserver,resize:()=>{}}
    state.resize=()=>{element.style.gridRowEnd=state.active?'span '+Math.ceil((element.getBoundingClientRect().height+16)/4):''}
    state.observer=new ResizeObserver(state.resize);entries.set(element,state);state.observer.observe(element);state.resize()
  },
  updated(element,binding){const state=entries.get(element);if(state){state.active=binding.value;state.resize()}},
  unmounted(element){entries.get(element)?.observer.disconnect();entries.delete(element)}
}
