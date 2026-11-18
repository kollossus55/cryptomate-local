import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "./components/utils";
import { base44 } from "@/api/base44Client";
import { TrendingUp, History, LogOut, User, Sparkles, Bell, Shield, Activity, Brain, Target, Scan, Cpu, Lock, Users, FlaskConical, Gauge, Layers, ListChecks, ShieldAlert, Network, KeyRound, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import NotificationCenter from "./components/notifications/NotificationCenter";
import LegacyBanner from "./components/LegacyBanner";
import { PaperBanner, useV6Status } from "@/components/v6/shared";

const NAV_GROUPS = [
  { label: "V6", items: [
    { name: "Mission Control", path: "MissionControl", icon: Gauge },
    { name: "Strategies", path: "Strategies", icon: Layers },
    { name: "Signal Tests", path: "SignalTests", icon: ListChecks },
    { name: "Risk Controls", path: "RiskControls", icon: ShieldAlert },
    { name: "Exchanges", path: "Exchanges", icon: Network },
  ]},
  // Not V6 and not legacy: the Strategy Lab's paper accounts, including the market exposure account.
  { label: "Lab", items: [
    { name: "Strategy Lab", path: "StrategyLab", icon: FlaskConical },
  ]},
  { label: "Records", items: [
    { name: "Trade History", path: "TradeHistory", icon: History },
    { name: "Alerts", path: "Alerts", icon: Bell },
  ]},
  { label: "Account", items: [
    { name: "Security", path: "Security", icon: Lock },
  ]},
  { label: "Legacy", collapsible: true, items: [
    { name: "Trading", path: "Trading", icon: TrendingUp },
    { name: "Auto-Trading", path: "AutoTrading", icon: Sparkles },
    { name: "Trade Signals", path: "TradeSignals", icon: Target },
    { name: "Altcoin Scanner", path: "AltcoinScanner", icon: Scan },
    { name: "AI Signals", path: "AISignals", icon: Brain },
    { name: "AI Insights", path: "Insights", icon: Activity },
    { name: "Backtesting", path: "Backtesting", icon: Activity },
    { name: "Committee", path: "Committee", icon: Users },
    { name: "API Keys (live only)", path: "ExchangeSettings", icon: KeyRound },
    { name: "AI Settings", path: "AISettings", icon: Cpu },
  ]},
];

const LEGACY_PAGES = NAV_GROUPS.find((g) => g.collapsible).items.map((i) => i.path);
const LEGACY_OPEN_KEY = "cryptomate.legacyNavOpen";

const readLegacyOpen = () => {
  try { return localStorage.getItem(LEGACY_OPEN_KEY) === "1"; } catch { return false; }
};
const writeLegacyOpen = (open) => {
  try { localStorage.setItem(LEGACY_OPEN_KEY, open ? "1" : "0"); } catch { /* best effort */ }
};

// Its own component: Layout returns early before sign-in, and the status query must not.
function AlarmDot() {
  const { data } = useV6Status();
  const critical = data?.alarms?.critical ?? 0;
  if (critical <= 0) return null;
  return (
    <span className="ml-auto flex items-center gap-1 rounded-full bg-red-600 px-2 text-xs font-semibold text-white">
      {critical}
      <span className="sr-only">critical {critical === 1 ? "alarm" : "alarms"}</span>
    </span>
  );
}

export default function Layout({ children, currentPageName }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(readLegacyOpen);

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    try {
      // First check if user is authenticated
      const isAuthenticated = await base44.auth.isAuthenticated();
      
      if (!isAuthenticated) {
        // If not authenticated and not on home page, redirect to home
        if (currentPageName !== 'Home') {
          window.location.href = createPageUrl('Home');
        }
        setIsLoading(false);
        return;
      }
      
      // If authenticated, fetch user data
      const currentUser = await base44.auth.me();
      setUser(currentUser);
    } catch (error) {
      console.error("Failed to load user:", error);
      // If there's an error and we're not on home page, redirect to home
      if (currentPageName !== 'Home') {
        window.location.href = createPageUrl('Home');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    base44.auth.logout(createPageUrl('Home'));
  };

  // Don't show navigation on Home page (landing page)
  if (currentPageName === 'Home') {
    return <main>{children}</main>;
  }

  // Show loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  // If not authenticated and not loading, don't render (will redirect)
  if (!user && !isLoading) {
    return null;
  }

  const groups = NAV_GROUPS.map((group) => (
    group.label === "Account" && user?.role === 'admin'
      ? { ...group, items: [...group.items, { name: "Admin", path: "AdminDashboard", icon: Shield }] }
      : group
  ));

  const renderLink = (item) => {
    const Icon = item.icon;
    const isActive = currentPageName === item.path;
    const isAdmin = item.path === 'AdminDashboard';

    return (
      <Link
        key={item.path}
        to={createPageUrl(item.path)}
        onClick={() => setMobileOpen(false)}
        className={`px-3 py-2.5 rounded-xl transition-all duration-300 flex items-center gap-3 text-sm ${
          isActive
            ? isAdmin
              ? 'bg-red-600 text-white'
              : 'bg-indigo-600 text-white'
            : isAdmin
            ? 'text-red-400 hover:text-white hover:bg-red-600/20'
            : 'text-slate-400 hover:text-white hover:bg-slate-800'
        }`}
      >
        <Icon className="w-4 h-4 flex-shrink-0" />
        <span>{item.name}</span>
        {item.path === 'MissionControl' && <AlarmDot />}
      </Link>
    );
  };

  const groupLabelCls = "px-3 pt-4 pb-1 text-[10px] uppercase tracking-wider text-slate-500";
  const legacyShown = legacyOpen || LEGACY_PAGES.includes(currentPageName);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex">
      {/* Sidebar */}
      <aside
        className={`fixed md:sticky top-0 left-0 z-50 h-screen w-64 flex-shrink-0 border-r border-slate-800 bg-slate-900/80 backdrop-blur-lg flex flex-col transition-transform duration-300 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        {/* Logo */}
        <Link
          to={createPageUrl('MissionControl')}
          className="flex items-center gap-3 px-5 h-16 border-b border-slate-800 flex-shrink-0"
          onClick={() => setMobileOpen(false)}
        >
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
              <path d="m2 17 10 5 10-5"></path>
              <path d="m2 12 10 5 10-5"></path>
            </svg>
          </div>
          <div className="flex flex-col">
            <span className="text-white font-semibold leading-tight">CryptoMate</span>
            <span className="text-[10px] text-slate-400 leading-tight">V6 paper engine</span>
          </div>
        </Link>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-1">
          {groups.map((group) => (
            group.collapsible ? (
              <Collapsible
                key={group.label}
                open={legacyShown}
                onOpenChange={(open) => { setLegacyOpen(open); writeLegacyOpen(open); }}
              >
                <CollapsibleTrigger className={`${groupLabelCls} flex w-full items-center justify-between hover:text-slate-300`}>
                  {group.label}
                  <ChevronDown className={`w-3 h-3 transition-transform ${legacyShown ? 'rotate-180' : ''}`} aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-1">
                  {group.items.map(renderLink)}
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <div key={group.label} className="space-y-1">
                <p className={groupLabelCls}>{group.label}</p>
                {group.items.map(renderLink)}
              </div>
            )
          ))}
        </nav>

        {/* Bottom: Notifications + User Menu */}
        <div className="border-t border-slate-800 p-3 space-y-2 flex-shrink-0">
          <div className="px-1">
            <NotificationCenter />
          </div>

          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="w-full flex items-center gap-2 text-slate-300 hover:text-white justify-start px-2">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    user.role === 'admin'
                      ? 'bg-gradient-to-br from-red-500 to-orange-600'
                      : 'bg-gradient-to-br from-indigo-500 to-purple-600'
                  }`}>
                    {user.role === 'admin' ? (
                      <Shield className="w-4 h-4 text-white" />
                    ) : (
                      <User className="w-4 h-4 text-white" />
                    )}
                  </div>
                  <span className="text-sm truncate">{user.full_name || user.email}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56 bg-slate-900 border-slate-700" align="start" side="top">
                <div className="px-3 py-2">
                  <p className="text-sm font-medium text-white flex items-center gap-2">
                    {user.full_name || 'User'}
                    {user.role === 'admin' && (
                      <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                        Admin
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-slate-400">{user.email}</p>
                </div>
                <DropdownMenuSeparator className="bg-slate-700" />
                <DropdownMenuItem
                  onClick={handleLogout}
                  className="text-red-400 hover:text-red-300 hover:bg-red-500/10 cursor-pointer"
                >
                  <LogOut className="w-4 h-4 mr-2" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar */}
        <div className="md:hidden sticky top-0 z-30 flex items-center justify-between h-16 px-4 border-b border-slate-800 bg-slate-900/80 backdrop-blur-lg">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800"
            aria-label="Open menu"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <Link to={createPageUrl('MissionControl')} className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                <path d="m2 17 10 5 10-5"></path>
                <path d="m2 12 10 5 10-5"></path>
              </svg>
            </div>
            <span className="text-white font-semibold text-sm">CryptoMate</span>
          </Link>
          <div className="w-10" />
        </div>

        {/* Main Content */}
        <PaperBanner />
        {LEGACY_PAGES.includes(currentPageName) && <LegacyBanner page={currentPageName} />}
        <main className="flex-1">{children}</main>

        {/* Footer Disclaimer */}
        <footer className="border-t border-slate-800 bg-slate-900/50 mt-20">
          <div className="max-w-7xl mx-auto px-6 py-8">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
              <div className="max-w-2xl">
                <div className="max-w-2xl space-y-2">
                  <p className="text-slate-400 text-sm leading-relaxed">
                    <strong className="text-slate-300">V6 is paper only.</strong> It uses virtual funds and has no way to place real orders.
                    The legacy live-trading path is separate and stays off unless you arm it.
                  </p>
                  <p className="text-slate-500 text-xs leading-relaxed">
                    <strong className="text-slate-400">Risk Disclaimer:</strong> Trading cryptocurrencies and digital assets carries a high level of risk and may result in the loss of your entire investment.
                    CryptoMate is provided for educational and informational purposes only and does not constitute financial, investment, or trading advice.
                    You are solely responsible for any trades you execute and any losses you may incur. CryptoMate, its creators, and its affiliates accept no liability for any financial losses, damages, or consequences arising from the use of this platform.
                    Always do your own research and consult a licensed financial advisor before trading.
                  </p>
                </div>
              </div>
              <div className="text-slate-500 text-sm">
                © 2024 CryptoMate
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}