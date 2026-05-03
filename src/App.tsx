/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Scissors, 
  User, 
  Trash2, 
  History, 
  ChevronRight, 
  Plus, 
  Minus, 
  X, 
  Check, 
  CreditCard,
  PenTool,
  Wind,
  LogOut,
  Smartphone
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, signInWithGoogle } from './lib/firebase';
import { onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { doc, onSnapshot, setDoc, serverTimestamp, collection, query, orderBy, limit, deleteDoc } from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Types & Constants ---

type ServiceId = 'taglio' | 'taglio_barba' | 'barba_gold' | 'barba_standard';

interface Service {
  id: ServiceId;
  label: string;
  price: number;
  icon: React.ReactNode;
}

interface HistoryItem {
  uid: number;
  id: ServiceId | 'manuale';
  label: string;
  price: number;
  time: string;
  clients?: number;
}

interface DailyLog {
  date: string;
  displayDate: string;
  total: number;
  clients: number;
  counts: Record<ServiceId, number>;
  timestamp: number;
  ownerUid: string;
}

interface AppState {
  date: string;
  counts: Record<ServiceId, number>;
  history: HistoryItem[];
  logs: DailyLog[];
}

const SERVICES: Service[] = [
  { id: 'taglio', label: 'Taglio', price: 12, icon: <Scissors className="w-5 h-5" /> },
  { id: 'taglio_barba', label: 'Taglio & Barba', price: 18, icon: <Wind className="w-5 h-5" /> },
  { id: 'barba_gold', label: 'Barba Gold', price: 10, icon: <div className="font-serif italic text-lg leading-none">G</div> },
  { id: 'barba_standard', label: 'Barba Std', price: 8, icon: <div className="font-serif italic text-lg leading-none text-gold-soft">S</div> },
];

const TODAY = new Date().toLocaleDateString('it-IT');

// --- Components ---

const Logo = ({ size = 80 }: { size?: number }) => {
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div 
        style={{ width: size, height: size }}
        className="rounded-full border-4 border-barber-blue/30 bg-panel flex items-center justify-center p-2 relative overflow-hidden shrink-0 shadow-2xl"
      >
        <div className="absolute inset-0 border-[8px] border-panel rounded-full z-10" />
        <div className="absolute inset-2 border border-barber-blue/30 rounded-full" />
        <div className="flex flex-col items-center justify-center relative z-20">
          <Scissors className="w-6 h-6 text-barber-blue mb-0.5" />
          <span className="font-serif text-[8px] font-black text-ivory tracking-tighter uppercase leading-none">The Prince</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative group shrink-0">
      <div className="absolute -inset-1 bg-barber-blue/20 rounded-full blur-xl group-hover:bg-barber-blue/30 transition-all" />
      <img 
        src="/logo.svg" 
        alt="The Prince Logo" 
        onError={() => setError(true)}
        className="relative rounded-full border-2 border-line bg-panel shadow-2xl transition-transform hover:scale-105"
        style={{ width: size, height: size, objectFit: 'cover' }}
      />
    </div>
  );
};

const BarberPole = () => (
  <svg width="18" height="56" viewBox="0 0 18 56" fill="none" aria-hidden="true" className="shrink-0 opacity-80">
    <rect x="2" y="2" width="14" height="52" rx="7" fill="#0f172a" stroke="#334155" />
    <defs>
      <pattern id="stripes" x="0" y="0" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(40)">
        <rect width="4" height="12" fill="#2563eb" />
        <rect x="4" width="4" height="12" fill="#f8fafc" />
        <rect x="8" width="4" height="12" fill="#dc2626" />
      </pattern>
    </defs>
    <rect x="3" y="6" width="12" height="44" rx="6" fill="url(#stripes)" opacity="0.9" />
    <circle cx="9" cy="4" r="2" fill="#2563eb" />
    <circle cx="9" cy="52" r="2" fill="#dc2626" />
  </svg>
);

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState<'cassa' | 'archivio'>('cassa');
  const [counts, setCounts] = useState<Record<ServiceId, number>>({
    taglio: 0,
    taglio_barba: 0,
    barba_gold: 0,
    barba_standard: 0,
  });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [logs, setLogs] = useState<DailyLog[]>([]);
  const [extras, setExtras] = useState<Record<ServiceId, string>>({
    taglio: "",
    taglio_barba: "",
    barba_gold: "",
    barba_standard: "",
  });
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [manualAmount, setManualAmount] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);

  // Auth Observer
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Sync Daily Data (Today's Session)
  useEffect(() => {
    if (!user) return;

    const docId = `${user.uid}_${TODAY.replace(/\//g, '-')}`;
    const docRef = doc(db, 'sessions', docId);

    const unsubscribe = onSnapshot(docRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setCounts(data.counts);
        setHistory(data.history);
      } else {
        // First time today? Reset local state if it's a new day
        setCounts({ taglio: 0, taglio_barba: 0, barba_gold: 0, barba_standard: 0 });
        setHistory([]);
      }
      setIsLoaded(true);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `sessions/${docId}`);
    });

    return () => unsubscribe();
  }, [user]);

  // Sync Logs (Historical Data)
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'logs'),
      // Ordinamento rimosso se non ci sono indici, ma possiamo filtrare per ownerUid
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedLogs = snapshot.docs
        .map(doc => doc.data() as DailyLog)
        .filter(log => log.ownerUid === user.uid)
        .sort((a, b) => b.timestamp - a.timestamp);
      
      setLogs(fetchedLogs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'logs');
    });

    return () => unsubscribe();
  }, [user]);

  // Helper to persist session to Firestore
  const syncToFirestore = async (newCounts: Record<ServiceId, number>, newHistory: HistoryItem[]) => {
    if (!user) return;
    const docId = `${user.uid}_${TODAY.replace(/\//g, '-')}`;
    const docRef = doc(db, 'sessions', docId);

    const totalInc = newHistory.reduce((acc, item) => acc + item.price, 0);
    const serviceClients = (Object.values(newCounts) as number[]).reduce((a, b) => a + b, 0);
    const manualClientsCount = newHistory
      .filter(h => h.id === 'manuale')
      .reduce((a, b) => a + (b.clients || 1), 0);
    const totalCli = serviceClients + manualClientsCount;

    try {
      await setDoc(docRef, {
        date: TODAY,
        counts: newCounts,
        history: newHistory,
        totalIncome: totalInc,
        totalClients: totalCli,
        updatedAt: serverTimestamp(),
        ownerUid: user.uid
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `sessions/${docId}`);
    }
  };

  // Calculations (Client-side for reactive feel)
  const totalIncome = useMemo(() => 
    history.reduce((acc, item) => acc + item.price, 0),
  [history]);

  const totalClients = useMemo(() => {
    const serviceClients = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
    const manualClientsCount = history
      .filter(h => h.id === 'manuale')
      .reduce((a, b) => a + (b.clients || 1), 0);
    return serviceClients + manualClientsCount;
  }, [counts, history]);

  // Actions
  const addService = async (service: Service) => {
    const extraVal = parseFloat(extras[service.id].replace(",", ".")) || 0;
    const finalPrice = service.price + extraVal;
    
    const newCounts = { ...counts, [service.id]: counts[service.id] + 1 };
    
    const time = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const label = extraVal > 0 ? `${service.label} (+${extraVal}€ extra)` : service.label;
    
    const newItem = {
      uid: Date.now(),
      id: service.id,
      label,
      price: finalPrice,
      time
    };
    const newHistory = [newItem, ...history];
    
    setCounts(newCounts);
    setHistory(newHistory);
    setExtras(prev => ({ ...prev, [service.id]: "" }));

    await syncToFirestore(newCounts, newHistory);
  };

  const removeService = async (service: Service) => {
    if (counts[service.id] <= 0) return;
    
    const newCounts = { ...counts, [service.id]: counts[service.id] - 1 };
    const index = history.findIndex(item => item.id === service.id);
    if (index === -1) return;
    
    const newHistory = [...history];
    newHistory.splice(index, 1);
    
    setCounts(newCounts);
    setHistory(newHistory);

    await syncToFirestore(newCounts, newHistory);
  };

  const addManual = async () => {
    const price = parseFloat(manualAmount.replace(",", "."));
    if (isNaN(price) || price <= 0) return;
    
    const time = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const newItem = {
      uid: Date.now(),
      id: 'manuale' as const,
      label: `Importo Manuale`,
      price,
      time,
      clients: 1
    };
    const newHistory = [newItem, ...history];
    
    setHistory(newHistory);
    setManualAmount("");

    await syncToFirestore(counts, newHistory);
  };

  const archiveDay = async () => {
    if (!user) return;
    if (totalIncome === 0 && totalClients === 0) {
      resetDay();
      return;
    }

    const newLog: DailyLog = {
      date: TODAY,
      displayDate: new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long" }),
      total: totalIncome,
      clients: totalClients,
      counts: { ...counts },
      timestamp: Date.now(),
      ownerUid: user.uid
    };

    // 1. Save to logs
    const logId = `${user.uid}_${Date.now()}`;
    try {
      await setDoc(doc(db, 'logs', logId), { ...newLog, ownerUid: user.uid });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `logs/${logId}`);
    }

    // 2. Clear current session in DB
    const docId = `${user.uid}_${TODAY.replace(/\//g, '-')}`;
    try {
      await deleteDoc(doc(db, 'sessions', docId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `sessions/${docId}`);
    }

    resetDay();
  };

  const exportToCSV = () => {
    if (logs.length === 0) return;
    const headers = "Data;Clienti;Incasso Totale\n";
    const rows = logs.map(l => `${l.displayDate};${l.clients};${l.total.toFixed(2)}€`).join("\n");
    // BOM for Excel UTF-8 support
    const blob = new Blob(["\ufeff" + headers + rows], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `registro_cassa_prince_${TODAY.replace(/\//g, '-')}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const resetDay = () => {
    setCounts({ taglio: 0, taglio_barba: 0, barba_gold: 0, barba_standard: 0 });
    setHistory([]);
    setShowResetConfirm(false);
  };

  const formattedDate = new Date().toLocaleDateString("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-ink">
        <div className="flex flex-col items-center gap-4">
          <Logo size={80} />
          <motion.div 
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            className="w-6 h-6 border-2 border-barber-blue border-t-transparent rounded-full"
          />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-ink px-6 text-center">
        <header className="mb-12">
          <div className="flex justify-center items-center gap-4 mb-8">
            <BarberPole />
            <Logo size={120} />
            <BarberPole />
          </div>
          <h1 className="font-serif text-4xl font-black text-ivory tracking-tighter mb-2">The Prince</h1>
          <p className="text-xs tracking-[0.4em] uppercase text-barber-blue font-bold opacity-80">Gestione Cassa</p>
        </header>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-sm space-y-6"
        >
          <div className="bg-panel border border-line p-8 rounded-2xl shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-barber-red via-white to-barber-blue opacity-50" />
            <p className="text-sm text-slate-400 mb-8 leading-relaxed">
              Accedi con il tuo account Google per gestire la cassa e salvare i dati in tempo reale sul cloud.
            </p>
            <button 
              onClick={signInWithGoogle}
              className="w-full py-4 px-6 bg-ivory text-ink font-bold rounded-xl flex items-center justify-center gap-3 hover:bg-slate-200 transition-all active:scale-95 shadow-lg group"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continua con Google
            </button>
          </div>
          
          <div className="flex items-center justify-center gap-4 text-slate-600">
            <Smartphone className="w-4 h-4" />
            <span className="text-[10px] uppercase tracking-widest font-bold">Ottimizzato per Mobile</span>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center min-h-screen max-w-[520px] mx-auto px-4 pb-12 font-sans overflow-x-hidden">
      {/* View Switcher */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-panel/90 backdrop-blur-md border border-line p-1.5 rounded-full flex gap-1 shadow-2xl">
        <button 
          onClick={() => setView('cassa')}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-full text-[10px] tracking-[0.2em] uppercase font-bold transition-all ${
            view === 'cassa' ? 'bg-barber-blue text-white shadow-lg shadow-barber-blue/20' : 'text-slate-400 hover:text-ivory'
          }`}
        >
          <CreditCard className="w-3.5 h-3.5" />
          Cassa
        </button>
        <button 
          onClick={() => setView('archivio')}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-full text-[10px] tracking-[0.2em] uppercase font-bold transition-all ${
            view === 'archivio' ? 'bg-barber-blue text-white shadow-lg shadow-barber-blue/20' : 'text-slate-400 hover:text-ivory'
          }`}
        >
          <History className="w-3.5 h-3.5" />
          Archivio
        </button>
      </div>

      <AnimatePresence mode="wait">
        {view === 'cassa' ? (
          <motion.div 
            key="cassa"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            className="w-full flex flex-col items-center"
          >
            {/* Header */}
            <header className="w-full pt-10 pb-8 text-center border-b border-line bg-panel/30 shadow-lg relative mb-8">
              <div className="flex justify-center items-center gap-6 mb-6 relative">
                <BarberPole />
                <Logo size={96} />
                <BarberPole />
                
                <button 
                  onClick={() => signOut(auth)}
                  className="absolute right-0 top-1/2 -translate-y-1/2 p-2 bg-ink/40 text-slate-500 hover:text-barber-red rounded-lg border border-line transition-all active:scale-90"
                  title="Esci"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
              
              <div className="divider w-64 mx-auto mb-3">
                <span className="text-[10px] tracking-[0.3em] uppercase font-bold">Registro Attivo</span>
              </div>
              <p className="text-xs text-slate-500 capitalize tracking-widest font-medium opacity-70">
                {formattedDate}
              </p>
              
              {/* Barber stripes at the very top */}
              <div className="absolute top-0 left-0 w-full h-1.5 flex opacity-60">
                <div className="flex-1 bg-barber-red" />
                <div className="flex-1 bg-white" />
                <div className="flex-1 bg-barber-blue" />
                <div className="flex-1 bg-white" />
                <div className="flex-1 bg-barber-red" />
                <div className="flex-1 bg-white" />
                <div className="flex-1 bg-barber-blue" />
              </div>
            </header>

            {/* Hero Income Card */}
            <motion.section 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full bg-panel border-x border-b border-line border-t-4 border-t-barber-blue rounded-lg p-8 text-center shadow-2xl relative overflow-hidden"
            >
              <div className="relative z-10">
                <span className="text-[10px] tracking-[0.4em] text-barber-blue uppercase font-bold mb-4 block">
                  Incasso Giornaliero
                </span>
                <div className="font-serif text-6xl font-black text-ivory tracking-tighter flex items-center justify-center">
                  <span className="text-barber-red text-3xl mr-2 font-bold mb-4">€</span>
                  <motion.span
                    key={totalIncome}
                    initial={{ scale: 1.1, color: "#dc2626" }}
                    animate={{ scale: 1, color: "#f8fafc" }}
                  >
                    {totalIncome.toFixed(2)}
                  </motion.span>
                </div>
                <p className="text-xs text-slate-500 mt-4 tracking-widest">
                  {totalClients} {totalClients === 1 ? "cliente servito" : "clienti serviti"}
                </p>

                <div className="flex flex-wrap justify-center items-center gap-6 mt-8 pt-6 border-t border-line">
                  {SERVICES.map(s => (
                    <div key={s.id} className="min-w-[80px]">
                      <span className="font-serif text-2xl font-bold text-ivory block leading-none">
                        {counts[s.id]}
                      </span>
                      <span className="text-[9px] tracking-widest text-slate-400 font-bold uppercase mt-2 block opacity-80 whitespace-nowrap">
                        {s.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.section>

            {/* Action Tiles */}
            <div className="w-full grid grid-cols-2 gap-4 mt-10">
              {SERVICES.map((s, idx) => (
                <motion.div 
                  key={s.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: idx * 0.05 }}
                  className="flex flex-col bg-panel border border-line rounded-lg overflow-hidden group hover:border-barber-blue/50 transition-all shadow-xl"
                >
                  <button
                    onClick={() => addService(s)}
                    className="flex-1 flex flex-col items-center gap-3 p-5 pb-3 text-center active:scale-[0.97] transition-all"
                  >
                    <div className="w-12 h-12 rounded-full border border-barber-blue/20 flex items-center justify-center shrink-0 bg-ink/60 text-barber-blue group-hover:border-barber-blue/50 transition-colors">
                      {s.icon}
                    </div>
                    <div className="space-y-1">
                      <h3 className="font-serif text-lg font-bold text-ivory leading-tight truncate px-1">
                        {s.label}
                      </h3>
                      <div className="inline-block bg-barber-red/10 text-barber-red text-[10px] px-2.5 py-0.5 rounded-full font-black tracking-widest italic uppercase">
                        €{s.price}
                      </div>
                    </div>
                  </button>

                  {/* Extra Input Area */}
                  <div className="px-4 pb-4">
                    <div className="relative group/extra">
                      <input 
                        type="text"
                        inputMode="decimal"
                        placeholder="+ Extra (es. 1)"
                        value={extras[s.id]}
                        onChange={(e) => setExtras(prev => ({ ...prev, [s.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            addService(s);
                          }
                        }}
                        className="w-full bg-ink/40 border border-line rounded-md py-1.5 px-3 text-[11px] font-bold text-barber-blue outline-none focus:border-barber-red/50 transition-all placeholder:text-slate-600 text-center"
                      />
                    </div>
                  </div>
                  
                  <div className="flex border-t border-line divide-x divide-line bg-ink/20">
                    <button
                      onClick={() => removeService(s)}
                      disabled={counts[s.id] <= 0}
                      className="flex-1 py-3.5 flex justify-center items-center text-slate-600 hover:text-barber-red disabled:opacity-10 transition-colors active:scale-90"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <div className="flex-1 flex justify-center items-center text-xs font-mono font-bold text-slate-500">
                      {counts[s.id]}
                    </div>
                    <button
                      onClick={() => addService(s)}
                      className="flex-1 py-3.5 flex justify-center items-center text-barber-blue hover:text-barber-red transition-colors active:scale-90"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>

            {/* Manual Entry */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full flex flex-col bg-panel border border-line rounded-lg overflow-hidden mt-6 p-1 pr-2 shadow-2xl"
            >
              <div className="flex items-center gap-3 px-4 py-1">
                <div className="flex items-center gap-3 flex-1">
                  <PenTool className="w-4 h-4 text-barber-blue opacity-60" />
                  <input 
                    type="text"
                    inputMode="decimal"
                    placeholder="Importo manuale"
                    value={manualAmount}
                    onChange={(e) => setManualAmount(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        addManual();
                      }
                    }}
                    className="flex-1 bg-transparent border-none py-4 text-sm font-medium text-ivory outline-none placeholder:text-slate-600 tracking-wide"
                  />
                </div>
                <button
                  onClick={addManual}
                  disabled={!manualAmount || isNaN(parseFloat(manualAmount.replace(",", ".")))}
                  className={`h-11 w-11 rounded-md flex items-center justify-center transition-all ${
                    manualAmount ? 'bg-barber-red text-white shadow-lg' : 'bg-ink/50 text-slate-700'
                  }`}
                >
                  <Plus className="w-5 h-5 stroke-[3px]" />
                </button>
              </div>
            </motion.div>

            {/* History Section */}
            <AnimatePresence>
              {history.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="w-full mt-10 overflow-hidden"
                >
                  <div className="divider mb-5">
                    <span className="text-[10px] tracking-[0.4em] uppercase font-bold text-slate-500">Registro Corrente</span>
                  </div>
                  <div className="bg-panel/40 border border-line rounded-lg max-h-72 overflow-y-auto custom-scrollbar shadow-inner">
                    {history.map((h, i) => (
                      <motion.div 
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        key={h.uid}
                        className={`flex justify-between items-center px-5 py-4 ${i !== history.length - 1 ? 'border-b border-line' : ''}`}
                      >
                        <div className="flex items-center gap-4 truncate">
                          <span className="text-[11px] font-mono font-bold text-barber-blue/70 tabular-nums">
                            {h.time}
                          </span>
                          <div className="w-[1px] h-3 bg-line translate-y-[1px]" />
                          <span className="text-sm text-slate-300 font-medium truncate">
                            {h.label}
                          </span>
                        </div>
                        <span className="font-serif text-base font-black text-barber-red ml-2 shrink-0">
                          €{h.price.toFixed(2)}
                        </span>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Footer / Archive Action */}
            <div className="w-full mt-12 space-y-8">
              <div className="px-2">
                {!showResetConfirm ? (
                  <button 
                    onClick={() => setShowResetConfirm(true)}
                    className="w-full py-4 rounded-lg border border-line bg-panel text-slate-500 hover:text-ivory hover:border-barber-blue/30 transition-all text-[11px] font-bold tracking-[0.3em] uppercase active:scale-[0.99] shadow-xl"
                  >
                    Chiudi Giornata & Archivia
                  </button>
                ) : (
                  <motion.div 
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="flex gap-2"
                  >
                    <button 
                      onClick={() => setShowResetConfirm(false)}
                      className="flex-1 py-4 rounded-lg bg-panel border border-line text-slate-400 text-[11px] font-bold tracking-widest uppercase hover:text-ivory transition-colors"
                    >
                      Annulla
                    </button>
                    <button 
                      onClick={archiveDay}
                      className="flex-[1.8] py-4 rounded-lg bg-barber-blue text-white text-[11px] font-black tracking-widest uppercase shadow-2xl active:scale-[0.95] transition-all"
                    >
                      Conferma & Salva
                    </button>
                  </motion.div>
                )}
              </div>

              <footer className="text-center pb-24 opacity-30">
                <div className="divider mb-4 opacity-30">
                  <span className="font-serif italic text-sm text-barber-blue opacity-40 px-2 tracking-widest">· A ·</span>
                </div>
                <div className="space-y-1.5">
                  <p className="text-[10px] tracking-[0.4em] uppercase font-bold text-gray-400/80">
                    The Prince · Barber Shop
                  </p>
                  <p className="text-[9px] tracking-[0.2em] italic font-medium text-gray-400">
                    Digital Craft by Adil
                  </p>
                </div>
              </footer>
            </div>
          </motion.div>
        ) : (
          <motion.div 
            key="archivio"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            className="w-full pt-12 pb-24 px-2"
          >
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-10 bg-panel p-6 rounded-lg border border-line shadow-2xl">
              <div>
                <h2 className="font-serif text-3xl font-black text-ivory tracking-tight">Archivio Storico</h2>
                <p className="text-[10px] tracking-widest text-barber-blue uppercase mt-1 font-bold">Riepilogo Database</p>
              </div>
              <div className="flex gap-2 w-full sm:w-auto">
                {logs.length > 0 && (
                  <button 
                    onClick={exportToCSV}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-3 px-4 py-3 bg-barber-blue/10 border border-barber-blue/30 rounded-lg text-xs font-bold uppercase tracking-widest text-barber-blue hover:bg-barber-blue hover:text-white transition-all shadow-lg active:scale-95"
                  >
                    <Wind className="w-4 h-4 scale-x-[-1]" />
                    Esporta CSV
                  </button>
                )}
                <div className="p-3 bg-ink/50 border border-line rounded-lg hidden sm:block">
                  <History className="w-5 h-5 text-barber-blue" />
                </div>
              </div>
            </div>

            {logs.length === 0 ? (
              <div className="py-20 text-center border-2 border-dashed border-line rounded-lg">
                <span className="text-xs text-slate-600 tracking-widest uppercase block mb-2">Nessun dato archiviato</span>
                <p className="text-[10px] text-slate-700 italic">I dati appariranno qui dopo la chiusura della giornata</p>
              </div>
            ) : (
              <div className="space-y-4">
                {logs.map((log) => (
                  <motion.div 
                    layoutId={`log-${log.timestamp}`}
                    key={log.timestamp}
                    className="bg-panel border border-line rounded-lg p-6 overflow-hidden relative group shadow-lg hover:shadow-2xl transition-all"
                  >
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <p className="text-[10px] tracking-[0.2em] text-barber-red uppercase font-black mb-1">{log.displayDate}</p>
                        <p className="text-[9px] text-slate-500 font-medium opacity-60 uppercase">{new Date(log.timestamp).toLocaleDateString('it-IT', { year: 'numeric' })}</p>
                      </div>
                      <div className="text-right">
                        <span className="font-serif text-2xl font-black text-ivory tracking-tighter block leading-none">
                          €{log.total.toFixed(2)}
                        </span>
                        <span className="text-[9px] text-slate-500 tracking-widest uppercase mt-1.5 block">
                          {log.clients} Clienti
                        </span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-y-3 gap-x-4 border-t border-line/50 pt-4">
                      {SERVICES.map(s => (
                        <div key={s.id} className="flex justify-between items-center">
                          <span className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">{s.label}</span>
                          <span className="text-xs font-mono font-bold text-barber-blue">{log.counts[s.id] || 0}</span>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                ))}
                
                {/* Clear all option for testing/management */}
                <button 
                  onClick={() => {
                    if (confirm("Sei sicuro di voler svuotare tutto l'archivio?")) {
                      setLogs([]);
                    }
                  }}
                  className="w-full py-4 text-[9px] text-slate-700 hover:text-barber-red tracking-[0.4em] uppercase font-bold transition-colors"
                >
                  Svuota Archivio
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
