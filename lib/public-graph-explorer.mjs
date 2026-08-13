/** @param {unknown} value */
function scriptData(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  })[character] ?? character)
}

/**
 * Native, dependency-free graph explorer for the deterministic public graph.
 * @param {Array<{nodeClass:string,label:string,entries:Array<{publicId:string,label:string}>}>} groups
 */
export function createPublicGraphExplorerScript(groups) {
  const configuration = groups.slice(0, 5).map((group) => ({
    nodeClass: group.nodeClass,
    label: group.label,
    entries: group.entries.map((entry) => ({ publicId: entry.publicId, shortLabel: entry.label })),
  }))
  return `<script data-tracer-extension="t05-graph">(()=>{
    const ns="http://www.w3.org/2000/svg",configuration=${scriptData(configuration)},typeLabels=new Map(configuration.map(group=>[group.nodeClass,group.label])),shortLabels=new Map(configuration.flatMap(group=>group.entries.map(entry=>[entry.publicId,entry.shortLabel]))),reducedMotion=matchMedia("(prefers-reduced-motion: reduce)"),alphaDecay=.0228,velocityDecay=.4,dragClickTolerance=5
    const graphData=fetch(new URL(publicSiteRoot+"graph.json",document.baseURI)).then(response=>{if(!response.ok)throw new Error("public graph unavailable");return response.json()})
    const publicHref=route=>new URL(publicSiteRoot+route.replace(/^\\/+/,""),document.baseURI).pathname
    const compare=(left,right)=>{const a=new TextEncoder().encode(left),b=new TextEncoder().encode(right),length=Math.min(a.length,b.length);for(let index=0;index<length;index+=1)if(a[index]!==b[index])return a[index]-b[index];return a.length-b.length}
    const svgElement=(name,attributes={})=>{const element=document.createElementNS(ns,name);for(const [key,value]of Object.entries(attributes))element.setAttribute(key,String(value));return element}
    const clamp=(value,minimum,maximum)=>Math.max(minimum,Math.min(maximum,value))
    const setup=async root=>{
      if(root.hasAttribute("data-graph-bound"))return
      root.setAttribute("data-graph-bound","")
      const [contract,index]=await Promise.all([graphData,fetchData]),records=new Map(index.records.map(record=>[record.public_id,record])),byId=new Map(contract.nodes.map(node=>[node.public_id,node])),initialScope=root.dataset.graphScope,rootId=root.dataset.graphRootId??null
      const canvas=root.querySelector("[data-graph-canvas]"),svg=canvas?.querySelector("[data-graph-surface]"),status=root.querySelector("[data-graph-status]"),empty=root.querySelector("[data-graph-empty]"),heading=root.querySelector("[data-graph-title]"),inspector=root.querySelector("[data-graph-inspector]"),inspectorEmpty=inspector?.querySelector(".public-graph-inspector-empty"),inspectorContent=inspector?.querySelector(".public-graph-inspector-content")
      if(!canvas||!svg||!status||!empty||!heading||!inspector||!inspectorEmpty||!inspectorContent)return
      const activeTypes=new Set(contract.nodes.map(node=>node.node_class)),positions=new Map(),nodeElements=new Map(),edgeElements=new Map(),pointers=new Map()
      let scope=initialScope,focusRootId=rootId,depth=1,selectedId=null,hoveredId=null,visibleNodes=[],visibleEdges=[],layout="phone",width=720,height=500,view={x:0,y:0,k:1},frame=0,alpha=0,alphaTarget=0,drag=null,pan=null,pinch=null,moved=false
      for(const button of root.querySelectorAll("[data-graph-filter]")){
        const count=contract.nodes.filter(node=>node.node_class===button.dataset.graphFilter).length,label=button.querySelector("[data-graph-filter-label]")?.textContent??button.dataset.graphFilter,countElement=button.querySelector("[data-graph-filter-count]")
        if(countElement)countElement.textContent=String(count)
        button.setAttribute("aria-label",label+", "+count+" nodes")
      }
      const edgeKey=edge=>edge.source+"\\0"+edge.target
      const neighboursOf=(id,edges=contract.edges)=>[...new Set(edges.flatMap(edge=>edge.source===id?[edge.target]:edge.target===id?[edge.source]:[]))]
      const distancesFrom=(start,edges=visibleEdges)=>{const distances=new Map([[start,0]]),queue=[start];while(queue.length){const current=queue.shift(),next=(distances.get(current)??0)+1;for(const neighbour of neighboursOf(current,edges))if(!distances.has(neighbour)){distances.set(neighbour,next);queue.push(neighbour)}}return distances}
      const scopedIds=()=>{
        if(scope==="global")return new Set(contract.nodes.map(node=>node.public_id))
        const start=focusRootId??selectedId??rootId
        if(!start)return new Set(contract.nodes.map(node=>node.public_id))
        const distances=distancesFrom(start,contract.edges)
        return new Set([...distances].filter(([,distance])=>distance<=depth).map(([id])=>id))
      }
      const shortLabel=node=>shortLabels.get(node.public_id)??node.title
      const familyName=value=>{const normalized=String(value??"").trim();if(!normalized)return "";if(normalized.includes(","))return normalized.split(",",1)[0].trim();return normalized.split(/\\s+/).at(-1)??normalized}
      const paperCitation=record=>{const lead=familyName(record?.authors?.[0]),year=String(record?.year??"").trim(),author=lead+(record?.authors?.length>1?" et al.":"");return [author,year].filter(Boolean).join(" ")||"Paper"}
      const titleLines=(value,limit=23)=>{const words=value.trim().split(/\\s+/),lines=[""];for(const word of words){const index=lines.length-1,candidate=(lines[index]+" "+word).trim();if(candidate.length<=limit||lines[index]==="")lines[index]=candidate;else if(lines.length<2)lines.push(word);else{lines[1]=(lines[1]+" "+word).trim();break}}if(lines[1]?.length>limit)lines[1]=lines[1].slice(0,Math.max(1,limit-1)).trimEnd()+"…";return lines.slice(0,2)}
      const nodeRadius=node=>node.node_class==="paper"?36:23
      const seedPositions=()=>{
        const ordered=[...contract.nodes].sort((left,right)=>compare(left.public_id,right.public_id)),centerX=width/2,centerY=height/2
        ordered.forEach((node,index)=>{const angle=index*2.399963229728653,radius=65+index*13,point=positions.get(node.public_id)??{x:0,y:0,vx:0,vy:0,fx:null,fy:null};point.x=centerX+Math.cos(angle)*radius;point.y=centerY+Math.sin(angle)*radius*.72;point.vx=0;point.vy=0;point.fx=null;point.fy=null;positions.set(node.public_id,point)})
      }
      const setView=(next,animate=false)=>{
        view={x:next.x,y:next.y,k:clamp(next.k,.5,1.8)}
        root.dataset.graphZoom=view.k<.65?"far":view.k>(layout==="phone"?1.15:1.05)?"near":"mid"
        const viewport=svg.querySelector(".public-graph-viewport")
        if(viewport){viewport.style.transition=animate&&!reducedMotion.matches?"transform 240ms cubic-bezier(.2,.8,.2,1)":"none";viewport.setAttribute("transform","translate("+view.x+" "+view.y+") scale("+view.k+")")}
      }
      const updateGeometry=()=>{
        for(const node of visibleNodes){const point=positions.get(node.public_id),element=nodeElements.get(node.public_id);if(point&&element)element.setAttribute("transform","translate("+point.x+" "+point.y+")")}
        visibleEdges.forEach((edge,index)=>{const source=positions.get(edge.source),target=positions.get(edge.target),path=edgeElements.get(edgeKey(edge));if(!source||!target||!path)return;const dx=target.x-source.x,dy=target.y-source.y,length=Math.max(1,Math.hypot(dx,dy)),bend=(index%2===0?1:-1)*Math.min(24,length*.08),cx=(source.x+target.x)/2-dy/length*bend,cy=(source.y+target.y)/2+dx/length*bend;path.setAttribute("d","M "+source.x+" "+source.y+" Q "+cx+" "+cy+" "+target.x+" "+target.y)})
      }
      const tick=()=>{
        alpha+=(alphaTarget-alpha)*alphaDecay
        const points=visibleNodes.map(node=>({node,point:positions.get(node.public_id)})).filter(item=>item.point)
        for(const edge of visibleEdges){const source=positions.get(edge.source),target=positions.get(edge.target);if(!source||!target)continue;let dx=target.x-source.x,dy=target.y-source.y,distance=Math.max(1,Math.hypot(dx,dy)),force=(distance-104)*.012*alpha,fx=dx/distance*force,fy=dy/distance*force;if(source.fx===null){source.vx+=fx;source.vy+=fy}if(target.fx===null){target.vx-=fx;target.vy-=fy}}
        for(let leftIndex=0;leftIndex<points.length;leftIndex+=1)for(let rightIndex=leftIndex+1;rightIndex<points.length;rightIndex+=1){const left=points[leftIndex],right=points[rightIndex];let dx=right.point.x-left.point.x,dy=right.point.y-left.point.y,distance=Math.max(1,Math.hypot(dx,dy)),minimum=nodeRadius(left.node)+nodeRadius(right.node)+14,repel=Math.min(4,2600*alpha/(distance*distance));if(distance<minimum)repel+=(minimum-distance)*.03*alpha;const fx=dx/distance*repel,fy=dy/distance*repel;if(left.point.fx===null){left.point.vx-=fx;left.point.vy-=fy}if(right.point.fx===null){right.point.vx+=fx;right.point.vy+=fy}}
        for(const {point} of points){if(point.fx!==null){point.x=point.fx;point.y=point.fy;point.vx=0;point.vy=0;continue}point.vx+=(width/2-point.x)*.0024*alpha;point.vy+=(height/2-point.y)*.0024*alpha;point.vx*=1-velocityDecay;point.vy*=1-velocityDecay;point.x+=point.vx;point.y+=point.vy}
      }
      const startSimulation=(nextAlpha=1)=>{
        alpha=Math.max(alpha,nextAlpha)
        if(frame)return
        const step=()=>{frame=0;tick();updateGeometry();if(alphaTarget>0||alpha>.001)frame=requestAnimationFrame(step)}
        frame=requestAnimationFrame(step)
      }
      const updateFocus=()=>{
        const focusId=selectedId??hoveredId,distances=focusId?distancesFrom(focusId):new Map()
        root.toggleAttribute("data-graph-has-selection",Boolean(selectedId))
        for(const [id,element] of nodeElements){const distance=focusId?(distances.get(id)??99):-1;element.dataset.graphDistance=distance<0?"overview":distance<=2?String(distance):"far";element.setAttribute("aria-pressed",String(id===selectedId))}
        for(const edge of visibleEdges){const element=edgeElements.get(edgeKey(edge));if(!element)continue;element.dataset.graphEmphasis=!focusId?"overview":edge.source===focusId||edge.target===focusId?"focus":"dimmed"}
      }
      const makeGlyph=(node,className)=>{
        if(node.node_class==="concept")return svgElement("path",{class:className,d:"M 0 -10 L 10 0 L 0 10 L -10 0 Z"})
        if(node.node_class==="method")return svgElement("rect",{class:className,x:-9,y:-9,width:18,height:18,rx:3})
        if(node.node_class==="task")return svgElement("path",{class:className,d:"M 0 -10 L 9 -5 L 9 5 L 0 10 L -9 5 L -9 -5 Z"})
        return svgElement("circle",{class:className,cx:0,cy:0,r:node.node_class==="paper"?11:9})
      }
      const createNodeElement=node=>{
        const record=records.get(node.public_id),label=node.node_class==="paper"?paperCitation(record):shortLabel(node),lines=titleLines(node.title),group=svgElement("g",{class:"public-graph-node",tabindex:"0",role:"button","aria-pressed":"false","aria-label":"Select "+node.title+", "+(typeLabels.get(node.node_class)??node.node_class),"data-graph-node-id":node.public_id,"data-node-class":node.node_class}),target=svgElement("circle",{class:"public-graph-target",cx:0,cy:0,r:24}),far=makeGlyph(node,"public-graph-glyph public-graph-glyph-far"),mid=makeGlyph(node,"public-graph-glyph public-graph-glyph-main"),short=svgElement("text",{class:"public-graph-label public-graph-label-short",x:17,y:5}),near=svgElement("g",{class:"public-graph-near"}),title=svgElement("title")
        short.textContent=label;title.textContent=node.title
        if(node.node_class==="paper"){near.append(svgElement("rect",{class:"public-graph-paper-card",x:-86,y:-28,width:172,height:56,rx:10}));lines.forEach((line,lineIndex)=>{const text=svgElement("text",{class:"public-graph-paper-title",x:-72,y:-7+lineIndex*16});text.textContent=line;near.append(text)});const meta=svgElement("text",{class:"public-graph-paper-meta",x:-72,y:20});meta.textContent=paperCitation(record);near.append(meta)}else{near.append(makeGlyph(node,"public-graph-glyph public-graph-glyph-near"));lines.forEach((line,lineIndex)=>{const text=svgElement("text",{class:"public-graph-label public-graph-label-full",x:18,y:(lines.length===1?5:-4)+lineIndex*15});text.textContent=line;near.append(text)})}
        if(node.node_class==="author"){const initial=svgElement("text",{class:"public-graph-author-initial",x:0,y:4,"text-anchor":"middle"});initial.textContent=[...label][0]?.toLocaleUpperCase("en-US")??"";group.append(initial)}
        group.append(target,far,mid,short,near,title)
        group.addEventListener("pointerenter",()=>{hoveredId=node.public_id;updateFocus()});group.addEventListener("pointerleave",()=>{hoveredId=null;updateFocus()});group.addEventListener("focus",()=>{hoveredId=node.public_id;updateFocus()});group.addEventListener("blur",()=>{hoveredId=null;updateFocus()});group.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();selectNode(node.public_id)}})
        return group
      }
      const renderGraph=()=>{
        const ids=scopedIds(),baseNodes=contract.nodes.filter(node=>ids.has(node.public_id)),baseIds=new Set(baseNodes.map(node=>node.public_id));visibleNodes=baseNodes.filter(node=>activeTypes.has(node.node_class)).sort((left,right)=>compare(left.public_id,right.public_id));const visibleIds=new Set(visibleNodes.map(node=>node.public_id));visibleEdges=contract.edges.filter(edge=>baseIds.has(edge.source)&&baseIds.has(edge.target)&&visibleIds.has(edge.source)&&visibleIds.has(edge.target)).sort((left,right)=>compare(edgeKey(left),edgeKey(right)))
        nodeElements.clear();edgeElements.clear();svg.replaceChildren();const title=svgElement("title",{id:root.id+"-title"}),description=svgElement("desc",{id:root.id+"-description"}),viewport=svgElement("g",{class:"public-graph-viewport"}),edgeLayer=svgElement("g",{class:"public-graph-edges"}),nodeLayer=svgElement("g",{class:"public-graph-nodes"});title.textContent=scope==="global"?"Global public graph":"Local public graph";description.textContent="Select a node to reveal its relationships and details.";viewport.append(edgeLayer,nodeLayer);svg.append(title,description,viewport)
        visibleEdges.forEach(edge=>{const path=svgElement("path",{class:"public-graph-edge","data-graph-edge-source":edge.source,"data-graph-edge-target":edge.target});edgeElements.set(edgeKey(edge),path);edgeLayer.append(path)})
        visibleNodes.forEach(node=>{const element=createNodeElement(node);nodeElements.set(node.public_id,element);nodeLayer.append(element)})
        empty.hidden=visibleNodes.length!==0;status.textContent=visibleNodes.length+" nodes, "+visibleEdges.length+" connections, "+(scope==="global"?"Global":"Local depth "+depth);heading.textContent=scope==="global"?"Global Graph":"Local Graph";root.dataset.graphScope=scope;root.dataset.layoutReady="true";updateGeometry();setView(view);updateFocus();startSimulation(1)
      }
      const fitGraph=(animate=true)=>{
        if(visibleNodes.length===0){setView({x:0,y:0,k:1},animate);return}
        const points=visibleNodes.map(node=>positions.get(node.public_id)).filter(Boolean),minimumX=Math.min(...points.map(point=>point.x))-105,maximumX=Math.max(...points.map(point=>point.x))+105,minimumY=Math.min(...points.map(point=>point.y))-55,maximumY=Math.max(...points.map(point=>point.y))+55,k=clamp(Math.min(width/Math.max(1,maximumX-minimumX),height/Math.max(1,maximumY-minimumY))*.9,.5,1.25),x=(width-(minimumX+maximumX)*k)/2,y=(height-(minimumY+maximumY)*k)/2;setView({x,y,k},animate)
      }
      const centerNode=id=>{const point=positions.get(id);if(!point)return;setView({x:width/2-point.x*view.k,y:height/2-point.y*view.k,k:view.k},true)}
      const renderInspector=id=>{
        const node=byId.get(id),record=records.get(id);if(!node)return
        inspectorEmpty.hidden=true;inspectorContent.hidden=false;inspector.querySelector("[data-graph-inspector-type]").textContent=(typeLabels.get(node.node_class)??node.node_class).replace(/s$/,"");inspector.querySelector("[data-graph-inspector-title]").textContent=node.title
        const metadata=[];if(record?.authors?.length)metadata.push(record.authors.join(", "));if(record?.doi)metadata.push("DOI "+record.doi);inspector.querySelector("[data-graph-inspector-meta]").textContent=metadata.join(" · ")
        const definition=inspector.querySelector("[data-graph-inspector-definition]"),definitionText=inspector.querySelector("[data-graph-inspector-definition-text]");if(definition&&definitionText){const supported=["concept","method","task"].includes(node.node_class)&&Boolean(record?.definition);definition.hidden=!supported;definitionText.textContent=supported?record.definition:""}
        const open=inspector.querySelector("[data-graph-inspector-link]"),doi=inspector.querySelector("[data-graph-inspector-doi]");open.href=publicHref(node.url);if(record?.doi){doi.href="https://doi.org/"+record.doi.split("/").map(encodeURIComponent).join("/");doi.hidden=false}else doi.hidden=true
        const related=neighboursOf(id).map(relatedId=>byId.get(relatedId)).filter(Boolean).sort((left,right)=>compare(left.public_id,right.public_id)),list=inspector.querySelector("[data-graph-relations]");inspector.querySelector("[data-graph-relation-count]").textContent=String(related.length);list.replaceChildren();for(const relatedNode of related){const item=document.createElement("li"),button=document.createElement("button");button.type="button";button.textContent=shortLabel(relatedNode);button.dataset.nodeClass=relatedNode.node_class;button.addEventListener("click",()=>selectNode(relatedNode.public_id));item.append(button);list.append(item)}
      }
      const setInspectorOpen=open=>{root.dataset.graphOverlay=open?"inspector":"none"}
      const selectNode=id=>{if(!byId.has(id))return;selectedId=id;renderInspector(id);updateFocus();root.dataset.sheetState="peek";setInspectorOpen(true);centerNode(id)}
      const clearSelection=(returnGlobal=false)=>{selectedId=null;inspectorEmpty.hidden=false;inspectorContent.hidden=true;setInspectorOpen(false);if(returnGlobal&&scope!=="global"){scope="global";focusRootId=rootId;renderGraph()}else updateFocus()}
      const updateDimensions=()=>{const previousWidth=width,rect=canvas.getBoundingClientRect();width=Math.max(280,Math.floor(rect.width));height=Math.max(360,Math.floor(rect.height));const containerWidth=Math.floor(root.getBoundingClientRect().width);layout=containerWidth>=720?"wide":containerWidth>=600?"medium":containerWidth>=480?"tablet":"phone";root.dataset.graphLayout=layout;root.dataset.graphLandscape=String(innerHeight<600);svg.setAttribute("viewBox","0 0 "+width+" "+height);if(positions.size===0)seedPositions();else if(previousWidth>0&&previousWidth!==width)for(const point of positions.values())point.x=point.x*width/previousWidth;updateGeometry();fitGraph(false)}
      for(const button of root.querySelectorAll("[data-graph-filter]"))button.addEventListener("click",()=>{const type=button.dataset.graphFilter;if(activeTypes.has(type))activeTypes.delete(type);else activeTypes.add(type);button.setAttribute("aria-pressed",String(activeTypes.has(type)));renderGraph()})
      root.querySelector('[data-graph-action="close-inspector"]')?.addEventListener("click",()=>clearSelection());root.querySelector('[data-graph-action="toggle-sheet"]')?.addEventListener("click",()=>root.dataset.sheetState=root.dataset.sheetState==="expanded"?"peek":"expanded")
      canvas.addEventListener("wheel",event=>{event.preventDefault();const rect=canvas.getBoundingClientRect(),factor=event.deltaY>0?.9:1.1,nextK=clamp(view.k*factor,.5,1.8),px=event.clientX-rect.left,py=event.clientY-rect.top,setX=px-(px-view.x)*nextK/view.k,setY=py-(py-view.y)*nextK/view.k;setView({x:setX,y:setY,k:nextK})},{passive:false})
      canvas.addEventListener("pointerdown",event=>{if(event.target.closest?.("[data-graph-filter]"))return;moved=false;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});const nodeElement=event.target.closest?.("[data-graph-node-id]");if(nodeElement){const point=positions.get(nodeElement.dataset.graphNodeId);drag={id:nodeElement.dataset.graphNodeId,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,nodeX:point.x,nodeY:point.y,fx:point.fx,fy:point.fy,dragged:false};point.fx=point.x;point.fy=point.y}else pan={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,viewX:view.x,viewY:view.y,dragged:false}})
      canvas.addEventListener("pointermove",event=>{if(!pointers.has(event.pointerId))return;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.size===2){const values=[...pointers.values()],distance=Math.hypot(values[0].x-values[1].x,values[0].y-values[1].y);moved=true;canvas.setPointerCapture?.(event.pointerId);if(!pinch)pinch={distance,k:view.k};else if(pinch.distance>0)setView({...view,k:pinch.k*distance/pinch.distance});return}if(drag&&drag.pointerId===event.pointerId){const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;if(!drag.dragged&&Math.hypot(dx,dy)<=dragClickTolerance)return;if(!drag.dragged){drag.dragged=true;moved=true;canvas.setPointerCapture?.(event.pointerId);alphaTarget=.3;startSimulation(.3)}const point=positions.get(drag.id);point.fx=point.x=drag.nodeX+dx/view.k;point.fy=point.y=drag.nodeY+dy/view.k;updateGeometry()}else if(pan&&pan.pointerId===event.pointerId){if(Math.hypot(event.clientX-pan.startX,event.clientY-pan.startY)>dragClickTolerance){if(!pan.dragged){pan.dragged=true;canvas.setPointerCapture?.(event.pointerId)}moved=true}setView({x:pan.viewX+event.clientX-pan.startX,y:pan.viewY+event.clientY-pan.startY,k:view.k})}})
      const endPointer=event=>{pointers.delete(event.pointerId);if(drag&&drag.pointerId===event.pointerId){const point=positions.get(drag.id),clickedId=!drag.dragged&&event.type==="pointerup"?drag.id:null;point.fx=drag.fx;point.fy=drag.fy;if(drag.dragged){alphaTarget=0;startSimulation(.3)}drag=null;if(clickedId)selectNode(clickedId)}if(pan?.pointerId===event.pointerId)pan=null;if(pointers.size<2)pinch=null;requestAnimationFrame(()=>{moved=false})};canvas.addEventListener("pointerup",endPointer);canvas.addEventListener("pointercancel",endPointer);canvas.addEventListener("click",event=>{if(!event.target.closest?.("[data-graph-node-id]")&&!moved)clearSelection(true)})
      document.addEventListener("keydown",event=>{if(root.isConnected&&event.key==="Escape")clearSelection()})
      const resizeObserver=new ResizeObserver(()=>updateDimensions());resizeObserver.observe(root);resizeObserver.observe(canvas);updateDimensions();renderGraph();requestAnimationFrame(()=>fitGraph(false))
    }
    const setupAll=()=>document.querySelectorAll(".public-graph").forEach(root=>setup(root).catch(error=>{root.dataset.layoutReady="error";const status=root.querySelector("[data-graph-status]");if(status)status.textContent="Graph unavailable.";console.error(error)}))
    setupAll();document.addEventListener("nav",setupAll)
  })()</script>`
}
