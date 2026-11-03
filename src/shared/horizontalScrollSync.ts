/** Scroll events arrive later than assignments; remember each mirrored value to avoid echoes. */
export function linkHorizontalScroll(first:HTMLElement,second:HTMLElement,onChange:()=>void):()=>void {
  const seen=new Map<HTMLElement,number>([[first,first.scrollLeft],[second,second.scrollLeft]])
  const sync=(source:HTMLElement,target:HTMLElement)=>{
    const value=source.scrollLeft
    if(seen.get(source)===value)return
    seen.set(source,value)
    target.scrollLeft=value
    seen.set(target,target.scrollLeft)
    onChange()
  }
  const fromFirst=()=>sync(first,second),fromSecond=()=>sync(second,first)
  first.addEventListener('scroll',fromFirst,{passive:true});second.addEventListener('scroll',fromSecond,{passive:true})
  return ()=>{first.removeEventListener('scroll',fromFirst);second.removeEventListener('scroll',fromSecond)}
}
