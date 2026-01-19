import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { initializeApp, getApp, getApps } from "firebase/app";
import { getFirestore, collection, doc, getDoc, setDoc, getDocs, query, orderBy } from "firebase/firestore";

// --- TYPES ---
interface AZ104Question {
  text: string;
  correctAnswer: string;
  explanation?: string;
}

interface ExtractedQuestion {
  id: string;
  text: string;
  correctAnswer: string;
  explanation: string;
}

interface GroundingSource {
  title: string;
  uri: string;
}

interface InsightBlock {
  foundationalRule: string;
  whyItWorks: string;
  analogy: string;
  analogousFoundationalConcept: string;
  commonConfusion: string;
  examEliminationCue: string;
  memoryHook: string;
}

interface ExtractionResult {
  domain: string;
  blocks: InsightBlock[];
  sources?: GroundingSource[];
}

enum ProcessingStatus {
  IDLE = 'IDLE',
  LOADING = 'LOADING',
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR'
}

interface VaultItem {
  hash: string;
  domain: string;
  foundationalRule: string;
  masteredAt: string;
}

// --- FIREBASE SERVICE ---
const COLLECTION_NAME = "az104_master_principles";

const getFirebaseConfig = () => {
  const local = localStorage.getItem('vault_firebase_config');
  if (local) return JSON.parse(local);

  return {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
  };
};

const getDb = () => {
  const config = getFirebaseConfig();
  if (!config.projectId) return null;
  const app = getApps().length === 0 ? initializeApp(config) : getApp();
  return getFirestore(app);
};

const getQuestionHash = async (text: string): Promise<string> => {
  const msgUint8 = new TextEncoder().encode(text.trim().toLowerCase());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
};

const saveToVault = async (hash: string, domain: string, rule: string) => {
  try {
    const db = getDb();
    if (!db) return;
    const docRef = doc(db, COLLECTION_NAME, hash);
    await setDoc(docRef, { masteredAt: new Date().toISOString(), domain, foundationalRule: rule, hash });
  } catch (e) {}
};

const fetchVault = async (): Promise<VaultItem[]> => {
  try {
    const db = getDb();
    if (!db) return [];
    const q = query(collection(db, COLLECTION_NAME), orderBy("masteredAt", "desc"));
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as VaultItem);
  } catch (e) { return []; }
};

// --- GEMINI SERVICE ---
const EXTRACTION_PROMPT = `You are the "AZ-104 Concept Validation Engine." Convert questions into reusable logic patterns rooted in official MS Learn documentation. Output JSON.`;

const processInsights = async (questions: AZ104Question[]): Promise<ExtractionResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: { parts: [{ text: EXTRACTION_PROMPT }, { text: `PROCESS:\n${JSON.stringify(questions)}` }] },
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          domain: { type: Type.STRING },
          blocks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                foundationalRule: { type: Type.STRING },
                whyItWorks: { type: Type.STRING },
                analogy: { type: Type.STRING },
                analogousFoundationalConcept: { type: Type.STRING },
                commonConfusion: { type: Type.STRING },
                examEliminationCue: { type: Type.STRING },
                memoryHook: { type: Type.STRING }
              }
            }
          }
        }
      }
    }
  });

  const sources: GroundingSource[] = [];
  response.candidates?.[0]?.groundingMetadata?.groundingChunks?.forEach((chunk: any) => {
    if (chunk.web) sources.push({ title: chunk.web.title, uri: chunk.web.uri });
  });

  return { ...JSON.parse(response.text || '{}'), sources };
};

const cleanAndExtractAnswers = async (rawText: string, pdfBase64?: string): Promise<ExtractedQuestion[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
  const parts: any[] = [{ text: "Extract ONLY questions answered correctly as JSON. Format: {id, text, correctAnswer, explanation}." }];
  if (pdfBase64) parts.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });
  else parts.push({ text: rawText });

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: { parts },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            text: { type: Type.STRING },
            correctAnswer: { type: Type.STRING },
            explanation: { type: Type.STRING }
          }
        }
      }
    }
  });
  return JSON.parse(response.text || '[]');
};

// --- COMPONENTS ---
const SettingsDrawer: React.FC<{ isOpen: boolean; onClose: () => void; isApiKeySet: boolean }> = ({ isOpen, onClose, isApiKeySet }) => {
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('vault_firebase_config');
    return saved ? JSON.parse(saved) : { projectId: '', apiKey: '', authDomain: '', appId: '' };
  });

  const save = () => {
    localStorage.setItem('vault_firebase_config', JSON.stringify(config));
    alert("Config saved. Reloading...");
    window.location.reload();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose}></div>
      <div className="relative w-full max-w-md bg-slate-900 p-8 shadow-2xl animate-in slide-in-from-right duration-300">
        <h3 className="text-xl font-black text-white mb-6 uppercase tracking-widest flex items-center gap-2">
          <i className="fa-solid fa-plug text-blue-500"></i> Integration Center
        </h3>
        <div className="space-y-6">
           <div className={`p-4 rounded-xl border ${isApiKeySet ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
             <p className="text-[10px] font-black uppercase text-slate-500">Gemini Logic Engine</p>
             <p className={`text-sm font-bold ${isApiKeySet ? 'text-emerald-400' : 'text-red-400'}`}>
               {isApiKeySet ? 'Connected' : 'Disconnected (Check Env)'}
             </p>
           </div>
           {['projectId', 'apiKey', 'authDomain', 'appId'].map(k => (
             <div key={k}>
               <label className="block text-[10px] text-slate-500 uppercase mb-1">{k}</label>
               <input 
                 className="w-full bg-slate-950 border border-slate-800 p-3 rounded text-sm text-slate-300 outline-none" 
                 value={(config as any)[k]} 
                 onChange={e => setConfig({...config, [k]: e.target.value})}
               />
             </div>
           ))}
           <button onClick={save} className="w-full py-4 bg-blue-600 text-white font-black rounded-xl hover:bg-blue-500">UPDATE VAULT CONFIG</button>
           <button onClick={onClose} className="w-full py-2 text-slate-500 text-xs font-bold uppercase">Close</button>
        </div>
      </div>
    </div>
  );
};

const AnswerExtractor: React.FC<{ onPush: (q: ExtractedQuestion) => void; isApiKeySet: boolean; currentStagedCount: number }> = ({ onPush, isApiKeySet, currentStagedCount }) => {
  const [input, setInput] = useState('');
  const [pdfData, setPdfData] = useState<string | null>(null);
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ExtractedQuestion[]>([]);
  const [pushedIds, setPushedIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isStagingFull = currentStagedCount >= 6;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file?.type === 'application/pdf') {
      const reader = new FileReader();
      reader.onload = () => {
        setPdfData((reader.result as string).split(',')[1]);
        setPdfName(file.name);
        setInput('');
      };
      reader.readAsDataURL(file);
    }
  };

  const handleExtract = async () => {
    if (!isApiKeySet || (!input.trim() && !pdfData)) return;
    setLoading(true);
    try {
      const q = await cleanAndExtractAnswers(input, pdfData || undefined);
      setResults(q);
      setPushedIds(new Set()); // Reset on new extraction
    } catch (err) {} finally { setLoading(false); }
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 flex flex-col gap-4 shadow-2xl h-full backdrop-blur-sm">
      <div className="flex justify-between items-center border-b border-slate-800 pb-4">
        <div className="flex flex-col">
          <h3 className="text-xs font-black uppercase tracking-widest text-blue-400">Answer Scraper</h3>
          <p className="text-[9px] text-slate-500 font-bold uppercase">Staging: {currentStagedCount} / 6</p>
        </div>
        <i className="fa-solid fa-broom-wide text-slate-600"></i>
      </div>
      {pdfData ? (
        <div className="bg-purple-600/10 border border-purple-500/30 p-4 rounded-xl relative text-center">
          <button onClick={() => {setPdfData(null); setPdfName(null);}} className="absolute top-2 right-2 text-slate-500"><i className="fa-solid fa-xmark"></i></button>
          <i className="fa-solid fa-file-pdf text-2xl text-purple-400 mb-2"></i>
          <p className="text-[10px] font-bold text-white truncate px-2">{pdfName}</p>
        </div>
      ) : (
        <>
          <textarea className="w-full h-32 bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-400 outline-none focus:border-blue-500 transition-colors" placeholder="Paste messy quiz text..." value={input} onChange={e => setInput(e.target.value)} />
          <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="application/pdf" className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} className="w-full py-2 border border-dashed border-slate-800 rounded-lg text-slate-500 hover:text-blue-400 text-[10px] font-bold uppercase transition-all">Upload PDF</button>
        </>
      )}
      <button disabled={loading} onClick={handleExtract} className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white text-[10px] font-black uppercase transition-all shadow-lg">
        {loading ? 'CLEANING...' : 'EXTRACT VALID ANSWERS'}
      </button>
      <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
        {results.map((q, i) => {
          const isPushed = pushedIds.has(q.id || q.text);
          const isDisabled = isPushed || isStagingFull;
          return (
            <div key={i} className={`p-4 bg-slate-950 border rounded-2xl transition-all ${isPushed ? 'border-emerald-500/20 opacity-50' : 'border-slate-800'}`}>
              <p className={`text-[10px] leading-relaxed mb-3 ${isPushed ? 'text-slate-600 italic' : 'text-slate-400'} line-clamp-3`}>{q.text}</p>
              <button 
                disabled={isDisabled} 
                onClick={() => {
                  onPush(q); 
                  setPushedIds(prev => new Set(prev).add(q.id || q.text));
                }} 
                className={`w-full py-2 rounded-lg text-[9px] font-black uppercase transition-all ${
                  isPushed ? 'bg-emerald-500/10 text-emerald-500' : 
                  isStagingFull ? 'bg-red-500/10 text-red-500 cursor-not-allowed' :
                  'bg-blue-500/5 text-blue-400 hover:bg-blue-400 hover:text-white'
                }`}
              >
                {isPushed ? 'ALREADY PUSHED' : isStagingFull ? 'STAGING FULL (6 MAX)' : 'PUSH TO ENGINE'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [view, setView] = useState<'generator' | 'vault'>('generator');
  const [inputText, setInputText] = useState('');
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [vaultItems, setVaultItems] = useState<VaultItem[]>([]);
  const [isApiKeySet] = useState<boolean>(!!process.env.API_KEY);
  const [showSettings, setShowSettings] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => { if (view === 'vault') fetchVault().then(setVaultItems); }, [view]);

  // Robust count of staged questions based on "Question:" pattern
  const currentStagedCount = (inputText.match(/Question:/gi) || []).length;

  const handlePushToEngine = (q: ExtractedQuestion) => {
    setInputText(prev => {
      // Atomic check within the state setter to prevent race conditions
      const currentCount = (prev.match(/Question:/gi) || []).length;
      if (currentCount >= 6) {
        return prev; // Strictly deny
      }
      const formatted = `Question: ${q.text}\nCorrect Answer: ${q.correctAnswer}\nExplanation: ${q.explanation}`;
      return prev.trim() ? `${prev.trim()}\n\n${formatted}` : formatted;
    });
  };

  const handleProcess = async () => {
    if (!inputText.trim()) return;
    setStatus(ProcessingStatus.LOADING);
    try {
      // Hard limit on processing even if user somehow pastes more
      const raw = inputText.trim().split(/\n\s*\n/).filter(c => c.toLowerCase().includes("question:")).slice(0, 6);
      const extraction = await processInsights(raw.map(rq => ({ text: rq, correctAnswer: 'Verified' })));
      const hashes = await Promise.all(raw.map(getQuestionHash));
      for (let i = 0; i < (extraction.blocks || []).length; i++) {
        if (hashes[i]) await saveToVault(hashes[i], extraction.domain, extraction.blocks[i].foundationalRule);
      }
      setResult(extraction);
      setStatus(ProcessingStatus.SUCCESS);
    } catch (err) { setStatus(ProcessingStatus.ERROR); }
  };

  const handleCopyAll = () => {
    if (!result) return;
    const text = `DOMAIN: ${result.domain}\n\n` + result.blocks.map(b => `RULE: ${b.foundationalRule}\nWHY: ${b.whyItWorks}\nANALOGY: ${b.analogy}\nHook: ${b.memoryHook}`).join('\n\n');
    navigator.clipboard.writeText(text);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 flex flex-col min-h-screen">
      <header className="flex flex-col md:flex-row justify-between items-center gap-6 mb-12">
        <div className="text-center md:text-left">
           <h1 className="text-3xl font-black italic tracking-tighter text-white">ANALOGICAL <span className="text-blue-500">INSIGHT</span> EXTRACTOR</h1>
           <p className="text-slate-500 text-sm uppercase tracking-widest font-bold">AZ-104 Mastery Logic Engine</p>
        </div>
        <div className="flex gap-4">
          <div className="bg-slate-900 border border-slate-800 p-1 rounded-xl flex">
            <button onClick={() => setView('generator')} className={`px-6 py-2 rounded-lg text-xs font-black transition-all ${view === 'generator' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>GENERATOR</button>
            <button onClick={() => setView('vault')} className={`px-6 py-2 rounded-lg text-xs font-black transition-all ${view === 'vault' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>VAULT</button>
          </div>
          <button onClick={() => setShowSettings(true)} className="w-10 h-10 bg-slate-900 border border-slate-800 rounded-xl flex items-center justify-center text-slate-500 hover:text-blue-400 transition-all">
            <i className="fa-solid fa-gear"></i>
          </button>
        </div>
      </header>

      <main className="flex-1">
        {view === 'generator' ? (
          result ? (
            <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4">
              <div className="flex justify-between items-center px-4">
                <h2 className="text-xl font-black text-blue-500 uppercase italic tracking-tighter">Results: {result.domain}</h2>
                <div className="flex gap-2">
                  <button onClick={handleCopyAll} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-black rounded-lg transition-all flex items-center gap-2">
                    <i className={`fa-solid ${copyFeedback ? 'fa-check' : 'fa-copy'}`}></i>
                    {copyFeedback ? 'COPIED!' : 'COPY ALL'}
                  </button>
                  <button onClick={() => {setResult(null); setStatus(ProcessingStatus.IDLE);}} className="px-4 py-2 bg-slate-800 hover:bg-red-900/20 text-slate-400 hover:text-red-400 text-[10px] font-black rounded-lg transition-all uppercase">
                    Discard & Reset
                  </button>
                </div>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-8 rounded-3xl space-y-10 shadow-2xl">
                {result.blocks.map((b, i) => (
                  <div key={i} className="group relative border-l-2 border-blue-600/30 pl-8 hover:border-blue-500 transition-all">
                    <div className="absolute -left-[11px] top-0 w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center text-[8px] font-black text-white">{i+1}</div>
                    <h3 className="text-xl font-bold text-white mb-4 leading-tight">{b.foundationalRule}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
                      <div className="space-y-4">
                        <div><p className="text-blue-400 font-black uppercase mb-1">Logic</p><p className="text-slate-400 leading-relaxed">{b.whyItWorks}</p></div>
                        <div><p className="text-emerald-400 font-black uppercase mb-1">Analogy</p><p className="text-slate-500 italic">"{b.analogy}"</p></div>
                      </div>
                      <div className="space-y-4">
                        <div className="bg-slate-950 p-3 rounded-xl border border-slate-800"><p className="text-red-400 font-black uppercase mb-1">Trap</p><p className="text-slate-500">{b.commonConfusion}</p></div>
                        <div><p className="text-amber-400 font-black uppercase mb-1">Memory Hook</p><p className="text-lg font-black text-white italic tracking-tighter">"{b.memoryHook}"</p></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-full">
              <div className="lg:col-span-4 h-full">
                <AnswerExtractor isApiKeySet={isApiKeySet} currentStagedCount={currentStagedCount} onPush={handlePushToEngine} />
              </div>
              <div className="lg:col-span-8 flex flex-col gap-4">
                <div className="relative group flex-1">
                  <div className={`absolute -inset-0.5 bg-gradient-to-r ${currentStagedCount >= 6 ? 'from-red-600 to-orange-600' : 'from-blue-600 to-indigo-600'} rounded-3xl blur opacity-10 group-focus-within:opacity-20 transition`}></div>
                  <textarea className="relative w-full h-[450px] bg-slate-900/80 border border-slate-800 rounded-3xl p-8 text-slate-300 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500/30 transition-all shadow-2xl resize-none backdrop-blur-sm" placeholder="Questions pushed from the scraper will appear here (Max 6)..." value={inputText} onChange={e => setInputText(e.target.value)} />
                  <div className="absolute top-4 right-4 flex items-center gap-4">
                    <span className={`text-[10px] font-black uppercase ${currentStagedCount >= 6 ? 'text-red-400' : 'text-slate-600'}`}>Items: {currentStagedCount} / 6</span>
                    <button onClick={() => setInputText('')} className="text-slate-700 hover:text-red-400 text-xs font-bold uppercase transition-colors">Clear All</button>
                  </div>
                </div>
                <button disabled={status === ProcessingStatus.LOADING || !inputText.trim() || currentStagedCount === 0} onClick={handleProcess} className="w-full py-5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-white font-black rounded-3xl shadow-xl transition-all uppercase tracking-widest active:scale-95">
                  {status === ProcessingStatus.LOADING ? 'Extracting Core Principles...' : 'Analyze & Store in Vault'}
                </button>
              </div>
            </div>
          )
        ) : (
          <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500">
            <h2 className="text-xl font-black text-white mb-8 flex items-center gap-3"><i className="fa-solid fa-vault text-blue-500"></i> Mastered Principles</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {vaultItems.map((item, i) => (
                <div key={i} className="bg-slate-900 border border-slate-800 p-6 rounded-2xl hover:border-blue-500/50 transition-all shadow-lg group">
                  <div className="flex justify-between items-start mb-4">
                    <span className="text-[9px] font-black px-2 py-0.5 bg-blue-500/10 text-blue-500 rounded uppercase">{item.domain}</span>
                    <span className="text-[8px] text-slate-600 font-bold">{new Date(item.masteredAt).toLocaleDateString()}</span>
                  </div>
                  <h3 className="text-slate-200 font-bold leading-snug mb-4 group-hover:text-white transition-colors">{item.foundationalRule}</h3>
                  <button onClick={() => {navigator.clipboard.writeText(item.foundationalRule); alert('Copied Rule');}} className="text-[9px] font-black text-slate-600 hover:text-blue-400 uppercase tracking-widest">Copy Principle</button>
                </div>
              ))}
            </div>
            {vaultItems.length === 0 && <div className="text-center py-40 opacity-20"><i className="fa-solid fa-box-open text-6xl mb-4"></i><p className="font-bold uppercase text-xs tracking-[0.5em]">Vault Empty</p></div>}
          </div>
        )}
      </main>

      <SettingsDrawer isOpen={showSettings} onClose={() => setShowSettings(false)} isApiKeySet={isApiKeySet} />
      <footer className="mt-20 py-10 border-t border-slate-900 text-center opacity-30">
        <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.4em]">Grounded in MS Learn • Built for AZ-104 Master Class</p>
      </footer>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<React.StrictMode><App /></React.StrictMode>);
}