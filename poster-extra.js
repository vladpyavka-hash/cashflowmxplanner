function ymdParts(s){return String(s||'').split('-').map(Number)}
function weekdayIndex(s){const [y,m,d]=ymdParts(s);return new Date(Date.UTC(y,m-1,d,12)).getUTCDay()}
function monthChunks(from,to){const out=[];let [y,m]=ymdParts(from),[ty,tm]=ymdParts(to);while(y<ty||(y===ty&&m<=tm)){const start=`${y}-${String(m).padStart(2,'0')}-01`;const last=new Date(Date.UTC(y,m,0)).getUTCDate();const end=`${y}-${String(m).padStart(2,'0')}-${String(last).padStart(2,'0')}`;out.push({from:start<from?from:start,to:end>to?to:end});m++;if(m>12){m=1;y++}}return out}
function hourFromMexicoDateTime(s){const m=String(s||'').match(/\s(\d{2}):/);return m?Number(m[1]):null}
function recommendedWindow(hours){const vals=hours.map(h=>Math.max(0,Number(h.avgRevenueUsd)||0)),total=vals.reduce((a,b)=>a+b,0);if(total<=0)return{open:null,close:null,coverage:0};const tail=total*.025;let left=0,cum=0;while(left<24&&cum+vals[left]<=tail){cum+=vals[left];left++}let right=23;cum=0;while(right>=0&&cum+vals[right]<=tail){cum+=vals[right];right--}if(left>right){const peak=vals.indexOf(Math.max(...vals));left=right=peak}const covered=vals.slice(left,right+1).reduce((a,b)=>a+b,0)/total;return{open:left,close:Math.min(24,right+1),coverage:covered}}
function hourLabel(h){return `${String(h).padStart(2,'0')}:00`}

function createPosterExtra(ctx){
  const {poster,posterTry,rows,isClosed,compactDate,txDate,txDateTimeMexico,txAmount,txSpot,txId,txClient,txUser,txUserName,first,MEXICO_TZ}=ctx;
  const mexicoToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:MEXICO_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

  async function spotsMap(){const spots=rows(await posterTry(['spots.getSpots'])||[]);return new Map(spots.map(s=>[String(first(s,['spot_id','id'])??''),String(first(s,['spot_name','name'])||'')]))}

  async function getHourlyAnalysis(from,to,fx){
    const txs=rows(await poster('dash.getTransactions',{dateFrom:compactDate(from),dateTo:compactDate(to)})).filter(isClosed);
    const names=await spotsMap(),stores=new Map(),today=mexicoToday();
    for(const t of txs){const day=txDate(t),dt=txDateTimeMexico(t),hour=hourFromMexicoDateTime(dt),sid=txSpot(t),amount=txAmount(t);if(!day||day===today||hour==null||hour<0||hour>23)continue;if(!stores.has(sid))stores.set(sid,{spotId:sid,name:names.get(sid)||`Магазин ${sid}`,days:new Map()});const s=stores.get(sid);if(!s.days.has(day))s.days.set(day,{totalMinor:0,hours:Array.from({length:24},()=>({minor:0,checks:0}))});const d=s.days.get(day);d.totalMinor+=amount;d.hours[hour].minor+=amount;d.hours[hour].checks++}
    const toUsd=v=>v/100/fx,weekdays=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const result=[...stores.values()].map(s=>{const byWeekday=[];for(let w=0;w<7;w++){const active=[...s.days.entries()].filter(([date,d])=>weekdayIndex(date)===w&&d.totalMinor>0);const count=active.length,hours=Array.from({length:24},(_,h)=>{const minor=active.reduce((sum,[,d])=>sum+d.hours[h].minor,0),checks=active.reduce((sum,[,d])=>sum+d.hours[h].checks,0);return{hour:h,label:hourLabel(h),avgRevenueUsd:count?toUsd(minor)/count:0,avgChecks:count?checks/count:0}}),avgDailyRevenueUsd=count?active.reduce((sum,[,d])=>sum+toUsd(d.totalMinor),0)/count:0;for(const x of hours)x.shareOfDay=avgDailyRevenueUsd?x.avgRevenueUsd/avgDailyRevenueUsd:0;const rec=recommendedWindow(hours),peak=Math.max(...hours.map(x=>x.avgRevenueUsd),0);byWeekday.push({weekday:w,label:weekdays[w],activeDays:count,avgDailyRevenueUsd,hours,peakHour:peak>0?hours.find(x=>x.avgRevenueUsd===peak)?.hour:null,recommended:{open:rec.open,close:rec.close,openLabel:rec.open==null?'—':hourLabel(rec.open),closeLabel:rec.close==null?'—':hourLabel(rec.close%24),coverage:rec.coverage}})}return{spotId:s.spotId,name:s.name,byWeekday}}).sort((a,b)=>a.name.localeCompare(b.name));
    return{from,to,fx,timeZone:MEXICO_TZ,excludedCurrentDay:today,method:'Average by weekday/hour. Days with zero total store revenue and the current incomplete Mexico City day are excluded; zero-sales hours inside active days remain zero.',stores:result};
  }

  async function getSalesExport(from,to,fx){
    const names=await spotsMap(),chunks=monthChunks(from,to),all=[];
    for(const ch of chunks){const part=rows(await poster('dash.getTransactions',{dateFrom:compactDate(ch.from),dateTo:compactDate(ch.to)})).filter(isClosed);all.push(...part)}
    const seen=new Set(),transactions=[];
    for(const t of all){const id=txId(t),key=id||`${txSpot(t)}|${txDateTimeMexico(t)}|${txAmount(t)}`;if(seen.has(key))continue;seen.add(key);const dt=txDateTimeMexico(t),date=txDate(t);if(!date||date<from||date>to)continue;transactions.push({transactionId:id,spotId:txSpot(t),store:names.get(txSpot(t))||`Магазин ${txSpot(t)}`,dateMexico:date,dateTimeMexico:dt,weekday:weekdayIndex(date),hour:hourFromMexicoDateTime(dt),amountMxn:txAmount(t)/100,amountUsd:txAmount(t)/100/fx,clientId:txClient(t)||null,userId:txUser(t)==='unknown'?null:txUser(t),userName:txUserName(t)||null})}
    transactions.sort((a,b)=>String(a.dateTimeMexico).localeCompare(String(b.dateTimeMexico)));
    const dailyMap=new Map();for(const x of transactions){const k=`${x.spotId}|${x.dateMexico}`;if(!dailyMap.has(k))dailyMap.set(k,{spotId:x.spotId,store:x.store,date:x.dateMexico,revenueUsd:0,checks:0,registeredChecks:0});const d=dailyMap.get(k);d.revenueUsd+=x.amountUsd;d.checks++;if(x.clientId)d.registeredChecks++}
    const daily=[...dailyMap.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.store.localeCompare(b.store));
    return{meta:{generatedAt:new Date().toISOString(),timeZone:MEXICO_TZ,from,to,fx,transactionCount:transactions.length,note:'Normalized Poster sales export for forecasting. USD = MXN / fx.'},daily,transactions};
  }

  return{getHourlyAnalysis,getSalesExport};
}
module.exports={createPosterExtra};
