const ENDPOINT='https://api.triplydb.com/datasets/JensiGoyani/cosmo-select-skincare-/sparql';
    const PREFIX='PREFIX : <http://www.semanticweb.org/skincare#>';
    function buildQuery(condition,allergen){
      const allowedConditions=['Dryness','Acne','Redness','Dehydration'],requested=Array.isArray(condition)?condition:[condition],conditions=[...new Set(requested.filter(value=>allowedConditions.includes(value)))];
      if(!conditions.length)throw new Error('Choose at least one valid skin concern.');
      const conditionPatterns=conditions.map((value,index)=>`
  ?product :containsIngredient ?ingredient${index} .
  ?ingredient${index} :helpsWithCondition :${value} .`).join('\n');
      let allergenFilter='';
      if(allergen==='Fragrance')allergenFilter='FILTER NOT EXISTS { ?product :containsAllergen :Fragrance . }';
      else if(allergen==='Alcohol')allergenFilter='FILTER NOT EXISTS { ?product :containsAllergen :Alcohol . }';
      else if(allergen==='Both')allergenFilter='FILTER NOT EXISTS { ?product :containsAllergen :Fragrance . }\n  FILTER NOT EXISTS { ?product :containsAllergen :Alcohol . }';
      return `${PREFIX}

SELECT DISTINCT ?productName ?price ?brand ?type ?url ?image WHERE {
  ${conditionPatterns}
  ?product :productName ?productName .
  ?product :price ?price .
  ?product :productURL ?url .
  ?product :manufacturedBy ?b .
  ?b :brandName ?brand .
  ?product :hasProductType ?t .
  ?t :typeName ?type .
  OPTIONAL { ?product :productImage ?image . }
  ${allergenFilter}
}
ORDER BY ?price`;
    }

    const LOCAL_IMAGES={
      'CeraVe Hydrating Cleanser 473ml':'./images/products/CeraVe%20Hydrating%20Cleanser%20473ml.jpg',
      'La Roche-Posay Effaclar H Hydrating Cleansing Cream (200ml)':'./images/products/La%20Roche-Posay%20Effaclar%20H%20Hydrating%20Cleansing%20Cream%20(200ml).jpg'
    };
    const SKIN_OPTS=[
      {value:'Dryness',label:'Dryness',description:'Support for skin that feels rough or tight'},
      {value:'Acne',label:'Acne',description:'Products associated with blemish-prone skin'},
      {value:'Redness',label:'Redness',description:'Options for visibly reactive-looking skin'},
      {value:'Dehydration',label:'Dehydration',description:'Hydration-focused product matches'}
    ];
    const ALLERGEN_OPTS=[
      {value:'',label:'Show all',description:'Empty allergen value'},
      {value:'Fragrance',label:'No fragrance',description:'Exclude fragrance'},
      {value:'Alcohol',label:'No alcohol',description:'Exclude alcohol'},
      {value:'Both',label:'Avoid both',description:'Exclude fragrance and alcohol'}
    ];
    const CONCERN_ICONS={
      Dryness:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M7 6l5 3 5-3M7 18l5-3 5 3M4 12h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
      Acne:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.7"/></svg>',
      Redness:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-4.5 7-11a7 7 0 0 0-14 0c0 6.5 7 11 7 11Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 11c1-2 5-2 6 0" stroke="currentColor" stroke-width="1.7"/></svg>',
      Dehydration:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2S5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13Z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>'
    };
    const CONCERN_PRESENTATION={
      Dryness:{image:'./images/concerns/dryness.jpeg',description:'Comfort for skin that feels rough or tight.'},
      Acne:{image:'./images/concerns/acne.jpeg',description:'Clear care for blemish-prone skin.'},
      Redness:{image:'./images/concerns/redness.jpeg',description:'Calm visibly reactive-looking skin.'},
      Dehydration:{image:'./images/concerns/dehydration.webp',description:'Replenish skin with moisture-focused care.'}
    };
    const skinProblem=document.getElementById('skinProblem'),allergen=document.getElementById('allergen'),findBtn=document.getElementById('findBtn'),formMessage=document.getElementById('formMessage'),results=document.getElementById('results'),loading=document.getElementById('loading'),errorBox=document.getElementById('errorBox'),emptyBox=document.getElementById('emptyBox'),productGrid=document.getElementById('productGrid'),resultsCount=document.getElementById('resultsCount'),resultsMeta=document.getElementById('resultsMeta'),story=document.getElementById('story'),moreTitle=document.querySelector('.more-title'),skinProblemOpts=document.getElementById('skinProblemOpts'),allergenOpts=document.getElementById('allergenOpts'),loadingMsg=document.getElementById('loadingMsg'),quizForm=document.getElementById('quizForm'),clearAllergen=document.getElementById('clearAllergen'),resetChoicesButton=document.getElementById('resetChoices'),videoFallback=document.getElementById('videoFallback'),matchLayout=document.querySelector('.match-layout'),concernStage=document.getElementById('concernStage'),concernNeutralVideos=[document.getElementById('concernNeutralVideo'),document.getElementById('concernNeutralVideoNext')],concernMainImage=document.getElementById('concernMainImage'),concernNextImage=document.getElementById('concernNextImage'),activeConcernCopy=document.getElementById('activeConcernCopy'),activeConcernTitle=document.getElementById('activeConcernTitle'),activeConcernDescription=document.getElementById('activeConcernDescription');
    const matchStepItems=[...document.querySelectorAll('#matchSteps li')],selectionConcerns=document.getElementById('selectionConcerns'),selectionFilter=document.getElementById('selectionFilter'),ctaHelper=document.getElementById('ctaHelper'),concernStartHint=document.getElementById('concernStartHint'),concernRail=document.querySelector('.concern-rail');
    const resultsHeader=document.querySelector('.results-header');
    let loadingInterval,concernSwitchTimer,neutralCrossfadeTimer,neutralVideoIndex=0,neutralCrossfading=false,onboardingStep=1,activeConcernLayer=0,activeConcern='',resultStoryCleanup,resultStoryUpdate=null,pageMotionUpdate=null,lenis=null,requestController=null,searchRequestId=0,isSearching=false;

    function show(el){el.style.display='block'}function hide(el){el.style.display='none'}
    function restoreResultsIntro(){if(resultsHeader.parentElement!==results)results.insertBefore(resultsHeader,loading);if(resultsMeta.parentElement!==results)resultsHeader.after(resultsMeta)}
    function safeHttp(value){try{const url=new URL(value);return url.protocol==='https:'||url.protocol==='http:'}catch{return false}}
    function valueOf(binding,key,fallback=''){return binding[key]?.value||fallback}
    function price(value){const number=Number.parseFloat(value);return Number.isFinite(number)?`£${number.toFixed(2)}`:'Price unavailable'}
    function filterText(value){return value==='Fragrance'?'Fragrance excluded':value==='Alcohol'?'Alcohol excluded':value==='Both'?'Fragrance and alcohol excluded':'No ingredient filter'}
    function createImageFallback(name){
      const fallback=document.createElement('div');fallback.className='image-fallback';
      const mark=document.createElement('span');mark.className='fallback-mark';mark.textContent=(String(name).trim().match(/[A-Za-z0-9]/)?.[0]||'C').toUpperCase();
      const text=document.createElement('small');text.textContent='Image coming soon';fallback.append(mark,text);return fallback;
    }
    function normalizeVisibleProduct(image){
      if(!image.src.includes('/query-products-transparent/'))return;
      try{
        const sample=260,ratio=Math.min(1,sample/Math.max(image.naturalWidth,image.naturalHeight)),width=Math.max(1,Math.round(image.naturalWidth*ratio)),height=Math.max(1,Math.round(image.naturalHeight*ratio));
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,width,height);
        const pixels=context.getImageData(0,0,width,height).data;let left=width,top=height,right=-1,bottom=-1;
        for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2){if(pixels[(y*width+x)*4+3]>24){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y)}}
        if(right<left||bottom<top)return;
        const visibleWidth=(right-left+1)/width,visibleHeight=(bottom-top+1)/height,centerX=(left+right+1)/(2*width),centerY=(top+bottom+1)/(2*height);
        const scale=Math.max(.88,Math.min(1.35,.84/Math.max(visibleWidth,visibleHeight)));
        const shiftX=Math.max(-12,Math.min(12,(.5-centerX)*100*scale)),shiftY=Math.max(-10,Math.min(10,(.5-centerY)*100*scale));
        image.style.setProperty('--visible-scale',scale.toFixed(3));image.style.setProperty('--image-shift-x',`${shiftX.toFixed(2)}%`);image.style.setProperty('--image-shift-y',`${shiftY.toFixed(2)}%`);
      }catch(error){console.debug('Product image normalization skipped',error)}
    }
    function createProductImage(name,imageValue){
      const wrap=document.createElement('div');wrap.className='product-image-wrap';
      const candidates=[`./images/query-products-transparent/${encodeURIComponent(name)}.png`];if(LOCAL_IMAGES[name])candidates.push(LOCAL_IMAGES[name]);if(safeHttp(imageValue))candidates.push(imageValue);
      const image=document.createElement('img');image.alt=`${name} product`;image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';
      let index=0;const tryNext=()=>{if(index>=candidates.length){wrap.replaceChildren(createImageFallback(name));return}image.src=candidates[index++]};
      image.addEventListener('error',tryNext);image.addEventListener('load',()=>normalizeVisibleProduct(image));tryNext();
      wrap.append(image);return wrap;
    }
    function makeOption(option,group){
      const button=document.createElement('button');button.type='button';button.className='option-card';button.role=group==='skin'?'checkbox':'radio';button.dataset.value=option.value;
      const check=document.createElement('span');check.className='option-check';check.textContent='✓';check.setAttribute('aria-hidden','true');
      if(group==='skin'){const icon=document.createElement('span');icon.className='option-icon';icon.innerHTML=CONCERN_ICONS[option.value];button.append(icon)}
      const label=document.createElement('strong');label.textContent=option.label;const description=document.createElement('small');description.textContent=option.description;button.append(check,label,description);
      button.addEventListener('click',()=>{
        if(group==='allergen'&&button.getAttribute('aria-checked')==='true'&&option.value!==''){selectAllergen('');return}
        group==='allergen'?selectAllergen(option.value):selectSkin(option.value);
      });
      button.addEventListener('keydown',event=>radioKeys(event,group));return button;
    }
    function renderOptions(){SKIN_OPTS.forEach(option=>skinProblemOpts.append(makeOption(option,'skin')));ALLERGEN_OPTS.forEach(option=>allergenOpts.append(makeOption(option,'allergen')));syncOptions()}
    function selectedConditions(){return [...skinProblem.options].filter(option=>option.selected).map(option=>option.value)}
    function conditionText(value){const values=Array.isArray(value)?value:[value];return values.filter(Boolean).join(' + ')}
    function playNeutralConcern(){
      const current=concernNeutralVideos[neutralVideoIndex];current.classList.add('is-visible');current.classList.remove('is-fading');current.play().catch(()=>{});
    }
    function pauseNeutralConcern(){
      clearTimeout(neutralCrossfadeTimer);
      if(neutralCrossfading)neutralVideoIndex=1-neutralVideoIndex;
      concernNeutralVideos.forEach((video,index)=>{video.pause();if(index!==neutralVideoIndex)video.currentTime=0;video.classList.toggle('is-visible',index===neutralVideoIndex);video.classList.remove('is-fading')});
      neutralCrossfading=false;
    }
    function showNeutralConcern(){
      activeConcern='';clearTimeout(concernSwitchTimer);matchLayout.dataset.concern='';concernStage.dataset.concern='';concernStage.classList.add('is-neutral');activeConcernTitle.textContent='Choose a concern';activeConcernDescription.textContent='Select one or more skin concerns to begin.';[concernMainImage,concernNextImage].forEach(layer=>layer.className='');playNeutralConcern();syncOptions();
    }
    function updateConcernPreview(value,animate=true){
      if(!value){showNeutralConcern();return}
      const option=SKIN_OPTS.find(item=>item.value===value)||SKIN_OPTS[0],presentation=CONCERN_PRESENTATION[option.value],layers=[concernMainImage,concernNextImage];activeConcern=option.value;clearTimeout(concernSwitchTimer);concernStage.classList.remove('is-neutral');pauseNeutralConcern();matchLayout.dataset.concern=option.value;concernStage.dataset.concern=option.value;activeConcernTitle.textContent=option.label;activeConcernDescription.textContent=presentation.description;activeConcernCopy.classList.remove('is-switching');void activeConcernCopy.offsetWidth;activeConcernCopy.classList.add('is-switching');syncOptions();
      if(!animate){layers.forEach(layer=>layer.className='');layers[0].src=presentation.image;layers[0].alt=`${option.label} concern visual`;layers[0].className='is-current';activeConcernLayer=0;return}
      const outgoing=layers[activeConcernLayer],incomingIndex=1-activeConcernLayer,incoming=layers[incomingIndex];layers.forEach(layer=>layer.className='');outgoing.className='is-current';incoming.src=presentation.image;incoming.alt=`${option.label} concern visual`;requestAnimationFrame(()=>{outgoing.className='is-outgoing';incoming.className='is-incoming'});activeConcernLayer=incomingIndex;concernSwitchTimer=setTimeout(()=>{outgoing.className='';incoming.className='is-current'},680);
    }
    function updateOnboarding(){
      const conditions=selectedConditions(),hasConditions=conditions.length>0;
      if(!hasConditions)onboardingStep=1;
      matchStepItems.forEach((item,index)=>{const step=index+1;item.classList.toggle('is-active',step===onboardingStep);item.classList.toggle('is-complete',step<onboardingStep)});
      selectionConcerns.textContent=hasConditions?conditions.join(' · '):'No concerns selected';
      selectionFilter.textContent=allergen.value==='Fragrance'?'No fragrance':allergen.value==='Alcohol'?'No alcohol':allergen.value==='Both'?'No fragrance or alcohol':'No ingredient exclusions';
      concernStartHint.classList.toggle('is-hidden',hasConditions);
      concernRail.classList.toggle('needs-guidance',!hasConditions);
      ctaHelper.textContent=!hasConditions?'Choose at least one concern to continue.':'We’ll find products matching all selected concerns.';
    }
    function syncOptions(){
      const chosen=new Set(selectedConditions());
      [...skinProblemOpts.children].forEach(button=>{const selected=chosen.has(button.dataset.value);button.setAttribute('aria-checked',String(selected));button.classList.toggle('is-preview',button.dataset.value===activeConcern);button.tabIndex=0});
      [...allergenOpts.children].forEach(button=>{const selected=button.dataset.value===allergen.value;button.setAttribute('aria-checked',String(selected));button.tabIndex=selected?0:-1});findBtn.disabled=!selectedConditions().length||isSearching;updateOnboarding();
    }
    function selectSkin(value){const option=[...skinProblem.options].find(item=>item.value===value);if(option){option.selected=!option.selected;if(option.selected)activeConcern=value;else if(activeConcern===value)activeConcern=selectedConditions().at(-1)||''}onboardingStep=selectedConditions().length?2:1;formMessage.textContent='';updateConcernPreview(activeConcern)}function selectAllergen(value){allergen.value=value;if(selectedConditions().length)onboardingStep=2;syncOptions()}
    function resetChoices(){if(isSearching)return;[...skinProblem.options].forEach(option=>{option.selected=false});allergen.value='';onboardingStep=1;formMessage.textContent='';showNeutralConcern()}
    function radioKeys(event,group){
      if(!['ArrowRight','ArrowDown','ArrowLeft','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();
      const buttons=[...event.currentTarget.parentElement.children];let index=buttons.indexOf(event.currentTarget);
      if(event.key==='Home')index=0;else if(event.key==='End')index=buttons.length-1;else index=(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+buttons.length)%buttons.length;
      buttons[index].focus();if(group==='allergen')selectAllergen(buttons[index].dataset.value);
    }
    function addProductInfo(parent,binding,condition,allergenValue,headingClass=''){
      const brand=document.createElement('div');brand.className='brand';brand.textContent=valueOf(binding,'brand','Brand unavailable');
      const name=document.createElement('h3'),productName=valueOf(binding,'productName','Product name unavailable');name.className=headingClass;name.textContent=productName.replace(/\s+(\d+(?:\.\d+)?\s?(?:ml|g)\b)$/i,'\u00a0$1');if(!headingClass&&productName.length>46)name.classList.add('is-long-title');
      const type=document.createElement('div');type.className='product-type';type.textContent=valueOf(binding,'type','Product');
      const badges=document.createElement('div');badges.className='badges';
      const match=document.createElement('span');match.className='badge';match.textContent=`Matches ${conditionText(condition)}`;
      const filter=document.createElement('span');filter.className='badge filter';filter.textContent=filterText(allergenValue);badges.append(match,filter);
      const footer=document.createElement('div');footer.className='product-footer';const priceEl=document.createElement('span');priceEl.className='price';priceEl.textContent=price(valueOf(binding,'price'));footer.append(priceEl);
      const url=valueOf(binding,'url');if(safeHttp(url)){const link=document.createElement('a');link.className='product-link';link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='View product →';footer.append(link)}
      parent.append(brand,name,type,badges,footer);
    }
    function createCard(binding,condition,allergenValue){
      const card=document.createElement('article');card.className='product-card';const name=valueOf(binding,'productName','Product');card.append(createProductImage(name,valueOf(binding,'image')));
      const body=document.createElement('div');body.className='product-body';addProductInfo(body,binding,condition,allergenValue,'product-name');card.append(body);return card;
    }
    function renderResults(bindings,condition,allergenValue){
      if(resultStoryCleanup)resultStoryCleanup();restoreResultsIntro();story.replaceChildren();productGrid.replaceChildren();moreTitle.classList.remove('visible');
      const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,mobile=matchMedia('(max-width: 850px)').matches;
      const featured=bindings.slice(0,Math.min(4,bindings.length)),remaining=bindings.slice(featured.length);
      if(mobile||reduced||featured.length<2){bindings.forEach(item=>productGrid.append(createCard(item,condition,allergenValue)));moreTitle.classList.add('visible');return}
      const shell=document.createElement('div');shell.className='story-shell';
      const stickyFrame=document.createElement('div');stickyFrame.className='results-story-frame';
      const sticky=document.createElement('div');sticky.className='featured-layout story-sticky',stage=document.createElement('div');stage.className='story-stage',details=document.createElement('div');details.className='story-details',progress=document.createElement('div');progress.className='story-progress';
      const products=[],detailItems=[],arcPoints=[],arc=document.createElement('div'),arcTrack=document.createElement('div'),arcIndicator=document.createElement('span'),controls=document.createElement('div'),previous=document.createElement('button'),next=document.createElement('button');
      arc.className='story-arc';arcTrack.className='story-arc-track';arcIndicator.className='story-arc-indicator';arc.append(arcTrack,arcIndicator);
      controls.className='story-controls';previous.className='story-control';next.className='story-control';previous.type=next.type='button';previous.setAttribute('aria-label','Previous featured match');next.setAttribute('aria-label','Next featured match');previous.textContent='←';next.textContent='→';controls.append(previous,next);
      featured.forEach((item,index)=>{
        const product=document.createElement('div');product.className='story-product';product.append(createProductImage(valueOf(item,'productName','Product'),valueOf(item,'image')));stage.append(product);products.push(product);
        const detail=document.createElement('article');detail.className='story-detail';addProductInfo(detail,item,condition,allergenValue);details.append(detail);detailItems.push(detail);
        const point=document.createElement('button'),ratio=index/(featured.length-1),angle=Math.PI-ratio*Math.PI;point.type='button';point.className='story-arc-point';point.textContent=String(index+1).padStart(2,'0');point.setAttribute('aria-label',`Show featured match ${index+1}`);point.style.left=`${50+42*Math.cos(angle)}%`;point.style.top=`${50-39*Math.sin(angle)}%`;arc.append(point);arcPoints.push(point);
      });
      stage.append(arc,controls,progress);
      sticky.append(stage,details);stickyFrame.append(resultsHeader,resultsMeta,sticky);shell.append(stickyFrame);story.append(shell);remaining.forEach(item=>productGrid.append(createCard(item,condition,allergenValue)));moreTitle.classList.toggle('visible',remaining.length>0);
      const sizeStory=()=>{
        const transitionDistance=Math.min(window.innerHeight*.24,240),
          finalHoldDistance=Math.min(window.innerHeight*.12,110),
          storyHeight=stickyFrame.offsetHeight+(featured.length-1)*transitionDistance+finalHoldDistance;
        shell.style.height=`${Math.round(storyHeight)}px`;
      };
      const scheduleStorySize=()=>requestAnimationFrame(()=>{sizeStory();update()});
      sizeStory();addEventListener('resize',scheduleStorySize,{passive:true});stage.querySelectorAll('img').forEach(image=>{if(image.complete)scheduleStorySize();else{image.addEventListener('load',scheduleStorySize,{once:true});image.addEventListener('error',scheduleStorySize,{once:true})}});
      let activeIndex=0,lastActive=-1;
      const getStickyStart=()=>(document.querySelector('.nav')?.offsetHeight||0)+12;
      const goTo=index=>{const targetIndex=Math.max(0,Math.min(featured.length-1,index)),travel=Math.max(1,shell.offsetHeight-stickyFrame.offsetHeight),targetProgress=Math.min(.98,targetIndex/featured.length+.01),target=scrollY+shell.getBoundingClientRect().top-getStickyStart()+travel*targetProgress;if(lenis)lenis.scrollTo(target,{duration:.72});else scrollTo({top:target,behavior:'smooth'})};
      previous.addEventListener('click',()=>goTo(activeIndex-1));next.addEventListener('click',()=>goTo(activeIndex+1));arcPoints.forEach((point,index)=>point.addEventListener('click',()=>goTo(index)));
      // Refined skincare scenes: [center, edge, glow] — 01 sage/ivory · 02 blush/sand · 03 eucalyptus/champagne · 04 lavender-grey/pearl
      const scenePalettes=[
        ['#f6f3e8','#d4ddc9','#cdd8bd'],
        ['#f8efe6','#e4c7b6','#e7c4b1'],
        ['#f3f1e3','#ccd9cc','#cfdccb'],
        ['#f3f1f4','#cfccdc','#d1ccdf']
      ];
      const hexToRgb=hex=>{const value=parseInt(hex.slice(1),16);return[value>>16&255,value>>8&255,value&255]};
      const paletteRgb=scenePalettes.map(scene=>scene.map(hexToRgb));
      const mixRgb=(a,b,t)=>`rgb(${Math.round(a[0]+(b[0]-a[0])*t)},${Math.round(a[1]+(b[1]-a[1])*t)},${Math.round(a[2]+(b[2]-a[2])*t)})`;
      const smoothstep=(edge0,edge1,x)=>{const t=Math.min(1,Math.max(0,(x-edge0)/(edge1-edge0)));return t*t*(3-2*t)};
      const lastIndex=featured.length-1;
      const update=()=>{
        const stickyStart=getStickyStart(),rect=shell.getBoundingClientRect(),
          travel=Math.max(1,shell.offsetHeight-stickyFrame.offsetHeight),
          progressValue=Math.min(1,Math.max(0,(stickyStart-rect.top)/travel)),position=progressValue*lastIndex,
          base=Math.min(lastIndex-1,Math.max(0,Math.floor(position))),frac=position-base,
          blend=smoothstep(.05,.95,frac),
          active=progressValue>=.94?lastIndex:Math.min(lastIndex,Math.floor(progressValue*featured.length));
        activeIndex=active;
        products.forEach((item,index)=>{
          const selected=index===active;
          item.classList.toggle('is-active',selected);
          item.style.setProperty('--opacity',selected?'1':'0');
          item.style.setProperty('--product-y',selected?'0px':index<active?'-24px':'24px');
          item.style.setProperty('--product-x','0px');
          item.style.setProperty('--product-scale',selected?'1':'.96');
          item.style.setProperty('--visibility',selected?'visible':'hidden');
          item.style.zIndex=selected?'3':'1';
        });
        detailItems.forEach((item,index)=>{
          const selected=index===active;
          item.classList.toggle('is-active',selected);
          item.style.setProperty('--opacity',selected?'1':'0');
          item.style.setProperty('--detail-x',selected?'0px':index<active?'-22px':'22px');
          item.style.setProperty('--detail-y','0px');
          item.style.setProperty('--visibility',selected?'visible':'hidden');
          item.style.zIndex=selected?'3':'1';
        });
        arcPoints.forEach((point,index)=>point.classList.toggle('is-active',index===active));
        const pathAngle=Math.PI-(position/lastIndex)*Math.PI;arcIndicator.style.left=`${50+42*Math.cos(pathAngle)}%`;arcIndicator.style.top=`${50-39*Math.sin(pathAngle)}%`;
        const from=paletteRgb[base%paletteRgb.length],to=paletteRgb[(base+1)%paletteRgb.length];
        stage.style.setProperty('--scene-a',mixRgb(from[0],to[0],blend));
        stage.style.setProperty('--scene-b',mixRgb(from[1],to[1],blend));
        stage.style.setProperty('--scene-glow',mixRgb(from[2],to[2],blend));
        previous.disabled=active===0;next.disabled=active===lastIndex;
        progress.textContent=`MATCH ${String(active+1).padStart(2,'0')} / ${String(featured.length).padStart(2,'0')}`;if(active!==lastActive){progress.classList.remove('is-changing');void progress.offsetWidth;progress.classList.add('is-changing');setTimeout(()=>progress.classList.remove('is-changing'),300);lastActive=active}};
      resultStoryUpdate=()=>{sizeStory();update()};update();resultStoryCleanup=()=>{removeEventListener('resize',scheduleStorySize);if(resultStoryUpdate)resultStoryUpdate=null};
    }

    const LOADING_MESSAGES=['Finding products that match your preferences…','Checking product ingredients…','Applying your filters…','Preparing your recommendations…'];
    function startLoading(){let index=0;loadingMsg.textContent=LOADING_MESSAGES[0];clearInterval(loadingInterval);loadingInterval=setInterval(()=>{index=(index+1)%LOADING_MESSAGES.length;loadingMsg.textContent=LOADING_MESSAGES[index]},1800)}
    function setSearchBusy(busy){
      isSearching=busy;quizForm.setAttribute('aria-busy',String(busy));results.setAttribute('aria-busy',String(busy));
      [...skinProblemOpts.querySelectorAll('button'),...allergenOpts.querySelectorAll('button'),clearAllergen,resetChoicesButton].forEach(button=>{button.disabled=busy});
      findBtn.classList.toggle('is-loading',busy);findBtn.textContent=busy?'Finding matches…':'Show my matches';findBtn.disabled=busy||!selectedConditions().length;
    }
    function scrollToResults(){
      const navHeight=document.querySelector('.nav')?.offsetHeight||0,targetTop=window.scrollY+results.getBoundingClientRect().top-navHeight-12;
      if(lenis){lenis.resize();lenis.scrollTo(targetTop,{duration:.9})}
      else window.scrollTo({top:targetTop,behavior:'smooth'});
    }
    function waitForFeaturedImages(){
      const images=[...story.querySelectorAll('.story-stage img')];if(!images.length)return Promise.resolve();
      const pending=images.map(image=>image.complete?Promise.resolve():new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true})}));
      return Promise.race([Promise.all(pending),new Promise(resolve=>setTimeout(resolve,1400))]);
    }
    async function settleResultsAndScroll(){
      await waitForFeaturedImages();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(lenis)lenis.resize();
      if(resultStoryUpdate)resultStoryUpdate();
      results.classList.remove('is-settling');results.classList.add('is-ready');
      requestAnimationFrame(()=>requestAnimationFrame(scrollToResults));
    }
    async function findProducts(){
      const conditions=selectedConditions(),allergenValue=allergen.value;if(!conditions.length){formMessage.textContent='Please choose at least one skin concern first.';return}
      const requestId=++searchRequestId;if(requestController)requestController.abort();requestController=new AbortController();setSearchBusy(true);
      onboardingStep=3;updateOnboarding();
      const concernsLabel=conditionText(conditions);
      restoreResultsIntro();formMessage.textContent='';results.classList.remove('is-ready');results.classList.add('is-settling');show(results);show(loading);hide(errorBox);hide(emptyBox);story.replaceChildren();productGrid.replaceChildren();moreTitle.classList.remove('visible');resultsCount.textContent='Loading…';resultsMeta.textContent=`${concernsLabel} · ${filterText(allergenValue)} · Lowest price first`;startLoading();
      try{
        const response=await fetch(`${ENDPOINT}?query=${encodeURIComponent(buildQuery(conditions,allergenValue))}`,{headers:{Accept:'application/sparql-results+json'},signal:requestController.signal});
        if(!response.ok)throw new Error(`Recommendation service returned ${response.status}`);
        const data=await response.json();if(requestId!==searchRequestId)return;
        const bindings=Array.isArray(data?.results?.bindings)?data.results.bindings:[],uniqueBindings=[...new Map(bindings.map(item=>[item.url?.value||item.productName?.value,item])).values()];clearInterval(loadingInterval);hide(loading);
        if(!uniqueBindings.length){emptyBox.querySelector('p').textContent=allergenValue==='Both'?'No products match every selected concern while excluding both fragrance and alcohol. Try fewer concerns or one exclusion.':'No products matched every selected concern. Try removing one concern or changing the ingredient filter.';show(emptyBox);resultsCount.textContent='0 products';await settleResultsAndScroll();return}
        resultsCount.textContent=`${uniqueBindings.length} product${uniqueBindings.length===1?'':'s'}`;renderResults(uniqueBindings,conditions,allergenValue);await settleResultsAndScroll();
      }catch(error){
        if(error.name==='AbortError'||requestId!==searchRequestId)return;
        console.error('COSMO SELECT recommendation error',error);clearInterval(loadingInterval);hide(loading);errorBox.replaceChildren();
        const message=document.createElement('p');message.textContent='We couldn’t load the recommendations. Please check your connection and try again.';
        const retry=document.createElement('button');retry.type='button';retry.className='btn btn-primary';retry.textContent='Try again';retry.addEventListener('click',findProducts);errorBox.append(message,retry);show(errorBox);resultsCount.textContent='Unavailable';
        results.classList.remove('is-settling');results.classList.add('is-ready');
      }finally{
        if(requestId===searchRequestId){clearInterval(loadingInterval);setSearchBusy(false);requestController=null}
      }
    }
    function setupMotion(){
      const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,mobile=matchMedia('(max-width: 768px)').matches;
      const home=document.getElementById('home'),displayWord=home.querySelector('.hero-display-word'),section=document.getElementById('video-scroll'),frame=document.getElementById('videoFrame'),videos=[...section.querySelectorAll('video')],transition=document.querySelector('.video-transition'),moments=[...document.querySelectorAll('.video-moment')],nav=document.querySelector('.nav'),navAnchors=[...document.querySelectorAll('.nav-links a')],sections=[...document.querySelectorAll('main>section')];
      const playVideos=()=>{if(!reduced)videos.forEach(video=>{if(video.paused)video.play().catch(()=>{})})};
      videos.forEach(video=>{video.addEventListener('canplay',playVideos);video.addEventListener('error',()=>{videoFallback.style.display='block'});if(reduced){video.removeAttribute('autoplay');video.pause()}});
      const clamp=value=>Math.min(1,Math.max(0,value));
      pageMotionUpdate=()=>{
        const y=scrollY;nav.classList.toggle('scrolled',y>Math.max(40,home.offsetHeight-90));
        const marker=y+innerHeight*.42;let activeId='home';sections.forEach(item=>{if(marker>=item.offsetTop)activeId=item.id});navAnchors.forEach(link=>link.classList.toggle('active',link.getAttribute('href')===`#${activeId}`));
        if(!reduced&&!mobile){const heroProgress=clamp(y/Math.max(1,home.offsetHeight));home.style.setProperty('--hero-bg-y',`${heroProgress*20}px`);displayWord.style.setProperty('--display-parallax',`${(heroProgress*14).toFixed(1)}px`)};
        if(reduced||mobile)return;
        const rect=section.getBoundingClientRect(),available=Math.max(1,section.offsetHeight-innerHeight),raw=clamp(-rect.top/available);
        if(rect.bottom>0&&rect.top<innerHeight)playVideos();else videos.forEach(video=>{if(!video.paused)video.pause()});
        const expansion=clamp(raw/.68);frame.style.setProperty('--video-inset',`${12*(1-expansion)}%`);frame.style.setProperty('--video-radius',`${28*(1-expansion)}px`);
        moments.forEach(moment=>{const start=Number(moment.dataset.start),end=Number(moment.dataset.end),fade=.075,opacity=Math.min(clamp((raw-start)/fade),clamp((end-raw)/fade));moment.style.opacity=opacity;moment.style.transform=`translate3d(-50%,${(1-opacity)*22}px,0)`});
        transition.style.setProperty('--transition-y',`${100-clamp((raw-.82)/.18)*100}%`);
      };
    }
    function setupScrolling(){
      const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,mobile=matchMedia('(max-width: 768px)').matches;
      if(!reduced&&!mobile&&window.Lenis){try{lenis=new Lenis({duration:1.05,smoothWheel:true,wheelMultiplier:.9,touchMultiplier:1,syncTouch:false})}catch(error){console.warn('Lenis unavailable; using native scrolling.',error)}}
      document.querySelectorAll('a[href^="#"]').forEach(link=>link.addEventListener('click',event=>{const target=document.querySelector(link.getAttribute('href'));if(!target)return;event.preventDefault();if(lenis)lenis.scrollTo(target,{offset:-82});else target.scrollIntoView({behavior:reduced?'auto':'smooth',block:'start'})}));
      const animationLoop=time=>{if(lenis)lenis.raf(time);if(pageMotionUpdate)pageMotionUpdate();if(resultStoryUpdate)resultStoryUpdate();requestAnimationFrame(animationLoop)};
      requestAnimationFrame(animationLoop);
    }
    function setupNeutralVideoLoop(){
      if(matchMedia('(prefers-reduced-motion: reduce)').matches){concernNeutralVideos.forEach(video=>video.pause());return}
      concernNeutralVideos.forEach(video=>{video.playbackRate=.82});
      const monitor=()=>{
        const current=concernNeutralVideos[neutralVideoIndex];
        if(concernStage.classList.contains('is-neutral')&&!neutralCrossfading&&Number.isFinite(current.duration)&&current.duration>1&&current.currentTime>=current.duration-.82){
          neutralCrossfading=true;
          const nextIndex=1-neutralVideoIndex,next=concernNeutralVideos[nextIndex];
          next.currentTime=0;next.classList.add('is-visible');next.classList.remove('is-fading');next.play().catch(()=>{});
          current.classList.add('is-fading');
          neutralCrossfadeTimer=setTimeout(()=>{
            current.pause();current.currentTime=0;current.classList.remove('is-visible','is-fading');
            neutralVideoIndex=nextIndex;neutralCrossfading=false;
          },760);
        }
        requestAnimationFrame(monitor);
      };
      playNeutralConcern();requestAnimationFrame(monitor);
    }
    function setupPremiumMotion(){
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      document.documentElement.classList.add('motion-ready');
      const title=document.getElementById('hero-title'),titleText=title.textContent.trim(),words=titleText.split(/\s+/);title.setAttribute('aria-label',titleText);
      title.replaceChildren(...words.map((word,index)=>{const span=document.createElement('span');span.className='hero-word';span.style.setProperty('--word-index',index);span.setAttribute('aria-hidden','true');span.textContent=word;return span}));
      const revealGroups=[
        ['.match-intro',''],
        ['.match-steps',''],
        ['.filter-panel','reveal-left'],
        ['.concern-stage',''],
        ['.concern-rail','reveal-right'],
        ['.results-header',''],
        ['.more-title',''],
        ['footer .footer-inner','']
      ];
      const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target)}}),{threshold:.14,rootMargin:'0px 0px -7% 0px'});
      revealGroups.forEach(([selector,direction])=>document.querySelectorAll(selector).forEach(element=>{element.classList.add('reveal-on-scroll');if(direction)element.classList.add(direction);observer.observe(element)}));
      const videoSection=document.getElementById('video-scroll'),sectionObserver=new IntersectionObserver(entries=>entries.forEach(entry=>videoSection.classList.toggle('is-visible',entry.isIntersecting)),{threshold:.08});
      sectionObserver.observe(videoSection);
      const home=document.getElementById('home'),copy=home.querySelector('.hero-copy');
      home.addEventListener('pointermove',event=>{if(event.pointerType==='touch')return;const rect=home.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width-.5,y=(event.clientY-rect.top)/rect.height-.5;home.style.setProperty('--hero-depth-x',`${(x*-12).toFixed(1)}px`);home.style.setProperty('--hero-depth-y',`${(y*-9).toFixed(1)}px`);copy.style.setProperty('--copy-depth-x',`${(x*5).toFixed(1)}px`);copy.style.setProperty('--copy-depth-y',`${(y*4).toFixed(1)}px`)},{passive:true});
      home.addEventListener('pointerleave',()=>{home.style.setProperty('--hero-depth-x','0px');home.style.setProperty('--hero-depth-y','0px');copy.style.setProperty('--copy-depth-x','0px');copy.style.setProperty('--copy-depth-y','0px')},{passive:true});
      concernStage.addEventListener('pointermove',event=>{if(event.pointerType==='touch')return;const rect=concernStage.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width-.5,y=(event.clientY-rect.top)/rect.height-.5;concernStage.style.setProperty('--concern-x',`${(x*9).toFixed(1)}px`);concernStage.style.setProperty('--concern-y',`${(y*7).toFixed(1)}px`)},{passive:true});
      concernStage.addEventListener('pointerleave',()=>{concernStage.style.setProperty('--concern-x','0px');concernStage.style.setProperty('--concern-y','0px')},{passive:true});
    }
    quizForm.addEventListener('submit',event=>{event.preventDefault();findProducts()});clearAllergen.addEventListener('click',()=>selectAllergen(''));resetChoicesButton.addEventListener('click',resetChoices);
    const navToggle=document.getElementById('navToggle'),navLinks=document.getElementById('navLinks');navToggle.addEventListener('click',()=>{const open=navLinks.classList.toggle('open');navToggle.setAttribute('aria-expanded',String(open));document.body.classList.toggle('menu-open',open)});navLinks.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>{navLinks.classList.remove('open');navToggle.setAttribute('aria-expanded','false');document.body.classList.remove('menu-open')}));
    renderOptions();showNeutralConcern();setupNeutralVideoLoop();setupPremiumMotion();setupMotion();setupScrolling();
