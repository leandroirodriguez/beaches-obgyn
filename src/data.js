export const C = {
  primary:"#3E7C9D", teal:"#018585", bg:"#EDF6F7", wave:"#C8E8EC",
  surface:"#FFFFFF", text:"#222222", sub:"#666666", grey:"#E3ECEE",
  greyMid:"#B0C4C8", coral:"#FD9983"
};

export const PROVIDERS = [
  { id:1, name:"Dr. Sarah Mitchell", cred:"MD", color:"#3E7C9D", initials:"SM", short:"Mitchell" },
  { id:2, name:"Dr. James Okafor",   cred:"DO", color:"#78B1A0", initials:"JO", short:"Okafor"   },
  { id:3, name:"Dr. Priya Patel",    cred:"MD", color:"#FD9983", initials:"PP", short:"Patel"    },
  { id:4, name:"Dr. Elena Vasquez",  cred:"MD", color:"#8DA4D0", initials:"EV", short:"Vasquez"  },
  { id:5, name:"Dr. Marcus Chen",    cred:"DO", color:"#D4B483", initials:"MC", short:"Chen"     },
];

export const CALL_SCHEDULE = {
  "2026-10-01":1,"2026-10-02":2,"2026-10-03":3,"2026-10-04":4,"2026-10-05":5,
  "2026-10-06":1,"2026-10-07":2,"2026-10-08":3,"2026-10-09":4,"2026-10-10":5,
  "2026-10-11":1,"2026-10-12":2,"2026-10-13":3,"2026-10-14":4,"2026-10-15":5,
  "2026-10-16":1,"2026-10-17":2,"2026-10-18":3,"2026-10-19":4,"2026-10-20":5,
  "2026-10-21":1,"2026-10-22":2,"2026-10-23":3,"2026-10-24":4,"2026-10-25":5,
  "2026-10-26":1,"2026-10-27":2,"2026-10-28":3,"2026-10-29":4,"2026-10-30":5,"2026-10-31":1,
};

export const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const WD_SHORT = ["Su","Mo","Tu","We","Th","Fr","Sa"];
export const WD_FULL  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export const ff  = "Nunito, sans-serif";
export const ffb = "Nunito Sans, sans-serif";

export const pad      = n => String(n).padStart(2,"0");
export const dkey     = (y,m,d) => `${y}-${pad(m+1)}-${pad(d)}`;
export const byId     = id => PROVIDERS.find(p => p.id === id);
export const getDays  = (y,m) => new Date(y,m+1,0).getDate();
export const getFirst = (y,m) => new Date(y,m,1).getDay();

export const card  = (x={}) => Object.assign({ background:"#FFF", borderRadius:10, boxShadow:"0 1px 8px rgba(1,133,133,0.09)" }, x);
export const btnS  = (x={}) => Object.assign({ width:"100%", padding:"12px", borderRadius:8, border:"none", background:C.teal, color:"#fff", fontFamily:ff, fontWeight:800, fontSize:14, cursor:"pointer" }, x);
export const oBtnS = (x={}) => Object.assign({ padding:"10px 14px", borderRadius:8, border:`1.5px solid ${C.teal}`, background:"transparent", color:C.teal, fontFamily:ff, fontWeight:700, fontSize:12, cursor:"pointer" }, x);
export const inpS  = { width:"100%", padding:"10px 12px", borderRadius:8, border:"1.5px solid #E3ECEE", background:"#EDF6F7", fontFamily:"Nunito Sans, sans-serif", fontSize:13, color:"#222", outline:"none", boxSizing:"border-box" };
export const lblS  = { fontFamily:ff, fontWeight:700, fontSize:10, color:"#666", textTransform:"uppercase", letterSpacing:.8, display:"block", marginBottom:4 };
export const badge = s => ({ background:{ Pending:"#F7C082", Approved:"#78B1A0", Denied:"#FD9983" }[s]||"#E3ECEE", color:"#222", padding:"3px 10px", borderRadius:6, fontFamily:ff, fontWeight:700, fontSize:11 });