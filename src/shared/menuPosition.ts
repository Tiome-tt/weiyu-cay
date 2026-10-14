interface MenuBounds {x:number;y:number;width:number;height:number;left:number;top:number;right:number;bottom:number}
export function fitMenuToBounds({x,y,width,height,left,top,right,bottom}:MenuBounds){
 const gap=8,maximumX=Math.max(left+gap,right-width-gap),maximumY=Math.max(top+gap,bottom-height-gap)
 return {x:Math.max(left+gap,Math.min(x,maximumX)),y:Math.max(top+gap,Math.min(y,maximumY))}
}
