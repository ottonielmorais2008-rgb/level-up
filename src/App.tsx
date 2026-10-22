/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, googleProvider, appleProvider, ensureAuthenticated, analytics, linkGoogle, linkApple } from './lib/firebase';
import { signOut, onAuthStateChanged, User, linkWithPopup, OAuthProvider } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp, onSnapshot, collection, addDoc, arrayUnion } from 'firebase/firestore';
import { logEvent } from 'firebase/analytics';
import { QRCodeSVG } from 'qrcode.react';
import { handleFirestoreError, OperationType } from './lib/firebaseUtils';
import {
  handleMissionStreakUpdate,
  reconcileStreakSession,
  syncStreakFromRemote,
  type StreakSession,
} from './features/streak/streakController';
import { mergeStreakIntoStorage } from './services/streak/streakStorage';
import { getTodayUtcKey } from './services/streak/streakEngine';
import type { MissionCompletionRecord } from './services/streak/streakTypes';

function LoginPrompt({ onLoginSuccess, setIsLinking }: { onLoginSuccess: () => void; setIsLinking: (val: boolean) => void }) {
  const [loading, setLoading] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [showError, setShowError] = useState("");

  const handleLogin = async () => {
    setLoading(true);
    setIsLinking(true);
    setShowError("");
    try {
      await linkGoogle();
      setShowSaved(true);
      setTimeout(() => {
        setShowSaved(false);
        setIsLinking(false);
        onLoginSuccess();
      }, 2000);
    } catch (e) {
      console.error(e);
      setIsLinking(false);
      setShowError("error saving");
      setTimeout(() => setShowError(""), 3000);
    } finally {
      setLoading(false);
    }
  };

  if (showSaved) {
    return (
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute bottom-[80px] left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur-md px-6 py-3 rounded-full shadow-md border border-[#5C5CFF]/10 z-[300]"
      >
        <span className="text-[14px] font-semibold text-[#5C5CFF]">saved</span>
      </motion.div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.8 }}
      className="absolute bottom-[80px] left-1/2 -translate-x-1/2 z-[40] w-full flex justify-center px-4"
    >
      <button 
        onClick={handleLogin}
        disabled={loading}
        className="px-5 py-2.5 rounded-full bg-white/70 border border-black/5 shadow-[0_4px_12px_rgba(0,0,0,0.05)] text-[12px] font-medium text-[#A1A1A6] hover:text-[#1C1C1E] active:scale-95 transition-all flex items-center gap-2 backdrop-blur-md"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${showError ? 'bg-red-400' : 'bg-[#5C5CFF]'} ${loading ? 'animate-pulse' : ''}`} />
        <span className={showError ? "text-red-400" : ""}>{showError || (loading ? "saving..." : "Save your progress")}</span>
      </button>
    </motion.div>
  );
}
const RIVAL_RETURN = ["look who's back 😏", "you're waking up", "back for more?", "ready for a quick reset?", "let's go again"];
const RIVAL_HESITATE = ["waiting for something?", "tap the button", "tick tock...", "still scrolling?", "just one tap", "don't overthink it", "go"];
const RIVAL_MISSION = ["that took a while 😏", "not bad… finally", "don't stop now", "you almost had it", "finally.", "one more?", "you're getting into it", "keep going"];

function AnimatedXP({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  
  useEffect(() => {
    let startTime: number;
    const duration = 1000;
    const animate = (time: number) => {
      if (!startTime) startTime = time;
      const progress = Math.min((time - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.floor(ease * value));
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  }, [value]);

  return <span className="text-[24px] font-bold tracking-tight text-[#5C5CFF]">+{displayValue} XP</span>;
}

function RivalMessage({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="absolute top-[68%] left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center pointer-events-none w-full px-4">
      <AnimatePresence mode="wait">
        <motion.div
          key={text}
          initial={{ opacity: 0, y: 5, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 5, scale: 0.98 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="bg-transparent px-4 py-2 flex flex-col items-center justify-center w-max max-w-full"
        >
          <span className="text-[14px] font-medium text-[#A1A1A6] tracking-tight text-center">{text}</span>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

const getMissionData = (index: number) => {
  const cycle = Math.floor(index / 12);
  const baseMissions = [
    { title: "Interrupt", instruction: "Put your phone face down for {dur} seconds.", duration: 10, xp: 10 },
    { title: "Snap Out", instruction: "Clap your hands {count} and sit up straight.", duration: 5, xp: 10 },
    { title: "Eye Reset", instruction: "Look away from the screen for {dur} seconds.", duration: 15, xp: 10 },
    { title: "Still Mode", instruction: "Stay completely still for {dur} seconds.", duration: 10, xp: 15 },
    { title: "Micro Move", instruction: "Stand up and take {count} steps.", duration: 10, xp: 15 },
    { title: "Shoulder Reset", instruction: "Roll your shoulders slowly {count} times.", duration: 15, xp: 15 },
    { title: "Breath Lock", instruction: "Take one deep breath and hold for {dur} seconds.", duration: 10, xp: 20 },
    { title: "Hand Control", instruction: "Open and close your hands slowly {count} times.", duration: 15, xp: 20 },
    { title: "One Thought", instruction: "Think of one thing you need to do next.", duration: 10, xp: 20 },
    { title: "Name It", instruction: "Say out loud what you were just doing.", duration: 10, xp: 20 },
    { title: "Decision Snap", instruction: "Decide one small action and commit to it.", duration: 10, xp: 25 },
    { title: "Focus Lock", instruction: "Focus on one object for {dur} seconds.", duration: 15, xp: 25 },
  ];

  const steps = [1, 5, 7, 11];
  const step = steps[cycle % steps.length];
  const offset = cycle % 12;
  const positionInCycle = index % 12;
  
  const mappedIndex = (positionInCycle * step + offset) % 12;
  const base = baseMissions[mappedIndex];

  const durationAdd = cycle * 5;
  const finalDuration = index === 0 ? 5 : Math.min(base.duration + durationAdd, 45);
  const countAdd = cycle;

  const parsedInstruction = base.instruction
    .replace('{dur}', finalDuration.toString())
    .replace('{count}', () => {
      if (base.title === "Snap Out") return (1 + countAdd) === 1 ? "once" : (1 + countAdd) + " times";
      if (base.title === "Micro Move") return (3 + countAdd * 2).toString();
      if (base.title === "Shoulder Reset") return (5 + countAdd * 2).toString();
      if (base.title === "Hand Control") return (10 + countAdd * 5).toString();
      return "";
    });

  return {
    title: base.title,
    instruction: parsedInstruction,
    duration: finalDuration,
    xp: index === 0 ? 100 : index === 1 ? 80 : index === 2 ? 60 : base.xp + cycle * 5
  };
};

function HomeContent({ onStart, onChallenge, onInvite, onProfile, onStreakDetail, level, streak, justIncreasedStreak, completedMissions }: { onStart: () => void; onChallenge: () => void; onInvite: () => void; onProfile: () => void; onStreakDetail: () => void; level: number; streak: number; justIncreasedStreak?: boolean; completedMissions: number; key?: string }) {
  const [rivalMsg, setRivalMsg] = useState("");

  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    let t1: any, t2: any, t3: any, idleTimer: any;
    
    // Set idle true if user does nothing for 10 seconds
    idleTimer = setTimeout(() => setIsIdle(true), 10000);

    const hasCompletedMission = completedMissions > 0;

    if (!hasCompletedMission) {
      setRivalMsg(RIVAL_RETURN[Math.floor(Math.random() * RIVAL_RETURN.length)]);
      t1 = setTimeout(() => setRivalMsg(""), 3500);

      t2 = setTimeout(() => {
        setRivalMsg(RIVAL_HESITATE[Math.floor(Math.random() * RIVAL_HESITATE.length)]);
        t3 = setTimeout(() => setRivalMsg(""), 3500);
      }, 10000); // Hesitate after 10s
    } else {
      if (completedMissions === 1) {
        const FIRST_NUGE = ["again?", "see?", "told you."];
        setRivalMsg(FIRST_NUGE[Math.floor(Math.random() * FIRST_NUGE.length)]);
        t1 = setTimeout(() => setRivalMsg(""), 3500);
      }
      t2 = setTimeout(() => {
        setRivalMsg(RIVAL_HESITATE[Math.floor(Math.random() * RIVAL_HESITATE.length)]);
        t3 = setTimeout(() => setRivalMsg(""), 3500);
      }, 8000);
    }
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(idleTimer); };
  }, [completedMissions]);

  const hasCompletedMission = completedMissions > 0;

  return (
    <motion.div
      key="home"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-0 flex flex-col items-center justify-center z-10 bg-[#FDFDFB]"
    >
      <RivalMessage text={rivalMsg} />
      {/* Top Section - Only visible in State 2 */}
      <AnimatePresence>
        {hasCompletedMission && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="absolute top-12 left-0 right-0 flex justify-between px-8 z-20 items-center w-full"
          >
            {/* Level Indicator */}
            <button 
              onClick={onProfile}
              className="px-3 py-1.5 rounded-full bg-white/60 border border-white/80 backdrop-blur-md shadow-sm flex items-center gap-1.5 active:scale-95 transition-all outline-none"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-[#5C5CFF]" />
              <span className="text-[12px] font-semibold tracking-wide text-[#1C1C1E] opacity-80">Level {String(level).padStart(2, '0')}</span>
            </button>

            <div className="flex items-center gap-2">
              {/* Streak Indicator */}
              {streak > 0 && (
                <motion.button 
                  onClick={onStreakDetail}
                  initial={justIncreasedStreak ? { y: -2, opacity: 0 } : false}
                  animate={justIncreasedStreak ? { y: [0, -3, 0], opacity: 1, filter: ["drop-shadow(0 2px 4px rgba(0,0,0,0.02))", "drop-shadow(0 4px 12px rgba(255,159,10,0.2))", "drop-shadow(0 2px 4px rgba(0,0,0,0.02))"] } : {}}
                  transition={justIncreasedStreak ? { duration: 2, ease: "easeInOut" } : {}}
                  className="px-3 py-1.5 rounded-full bg-white/60 border border-white/80 backdrop-blur-md shadow-sm flex items-center gap-1.5 active:scale-95 transition-all outline-none"
                >
                  <div className="relative flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A] opacity-90 relative z-10"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
                    <div className="absolute inset-0 pointer-events-none">
                       <motion.div animate={{y: [0, -12], x: [0, -6], opacity: [0, 1, 0]}} transition={{duration: 1.5, repeat: Infinity, delay: 0.2}} className="absolute top-1 left-1.5 w-0.5 h-0.5 rounded-full bg-[#FF9F0A]" />
                       <motion.div animate={{y: [0, -10], x: [0, 5], opacity: [0, 1, 0]}} transition={{duration: 1.7, repeat: Infinity, delay: 0.7}} className="absolute top-1 right-1.5 w-[1.5px] h-[1.5px] rounded-full bg-[#FFB340]" />
                       <motion.div animate={{y: [0, -8], x: [0, 2], opacity: [0, 1, 0]}} transition={{duration: 1.3, repeat: Infinity, delay: 1.1}} className="absolute top-2 left-2 w-0.5 h-0.5 rounded-full bg-[#FF9F0A]" />
                    </div>
                  </div>
                  <span className="text-[12px] font-semibold text-[#1C1C1E] opacity-80 tracking-tight">{streak} day streak</span>
                </motion.button>
              )}

              {/* Invite / Social Button */}
              <button 
                onClick={onInvite}
                className="h-8 w-8 rounded-full bg-white/60 border border-white/80 backdrop-blur-md shadow-sm flex items-center justify-center text-[#1C1C1E] opacity-80 active:scale-95 transition-all outline-none"
                aria-label="Invite friends"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col items-center justify-center w-full relative z-10 max-w-[280px]">
        {/* Brand Title */}
        <motion.h1 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
          className={`text-[32px] font-medium tracking-tight text-[#1C1C1E] ${hasCompletedMission ? 'mb-16' : 'mb-2'} pointer-events-none`}
        >
          Level Up
        </motion.h1>

        {!hasCompletedMission && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="text-[14px] font-medium text-[#A1A1A6] mb-14"
          >
            start your reset
          </motion.p>
        )}

        {/* Primary Action Button */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
          className="relative w-full flex flex-col items-center"
        >
          <motion.button
            onClick={onStart}
            animate={{ scale: [1, 1.04, 1], boxShadow: ["0 8px 24px rgba(0,0,0,0.12)", "0 12px 32px rgba(92,92,255,0.2)", "0 8px 24px rgba(0,0,0,0.12)"] }}
            transition={{ duration: 1.2, repeat: Infinity, repeatDelay: 3.8, ease: "easeInOut" }}
            whileTap={{ scale: 0.96 }}
            className="w-full py-[18px] rounded-full bg-[#1C1C1E] text-white flex items-center justify-center shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-all relative overflow-hidden group outline-none"
            id="main-level-up-button"
          >
            <motion.div className="absolute inset-0 bg-white/20 opacity-0 group-active:opacity-100 transition-opacity duration-200" />
            <span className="text-[17px] font-medium tracking-wide relative z-10">
              Level Up now
            </span>
          </motion.button>
          
          <AnimatePresence>
            {hasCompletedMission && (
              <motion.button
                key="1v1"
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ delay: 0.5, duration: 0.6 }}
                onClick={onChallenge}
                className="mt-4 text-[14px] font-medium text-[#A1A1A6] hover:text-[#1C1C1E] transition-colors outline-none flex items-center gap-1"
              >
                <span>play 1v1</span>
              </motion.button>
            )}
          </AnimatePresence>
          
          {/* Subtle Glow below button to separate visually */}
          <div className="absolute -z-10 top-4 w-[70%] h-[80%] bg-[#1C1C1E]/30 blur-[20px] rounded-full pointer-events-none" />
        </motion.div>
      </div>
    </motion.div>
  );
}


function StreakMomentumContent({ streak, onBack, hasCompletedToday, shouldCelebratePerfectWeek }: { streak: number; onBack: () => void; hasCompletedToday: boolean; shouldCelebratePerfectWeek?: boolean; key?: string }) {
  const [subtext, setSubtext] = useState("days locked in");
  const [phrase, setPhrase] = useState("keep going.");
  const [isCelebrationActive, setIsCelebrationActive] = useState(false);
  
  const subtexts = ["days locked in", "days consistent", "still going", "locked in"];
  const strongPhrases = ["locked in.", "still going.", "consistency is rare.", "momentum is power."];
  const tensePhrases = ["don't break it now.", "keep it alive.", "almost lost.", "one more day."];
  const celebrationPhrases = ["perfect week.", "7 days locked in.", "consistency wins.", "keep going.", "still locked in."];

  useEffect(() => {
    const celebrate =
      shouldCelebratePerfectWeek ??
      (streak > 0 && streak % 7 === 0 && hasCompletedToday);
    if (celebrate) {
      setIsCelebrationActive(true);
      const timer = setTimeout(() => setIsCelebrationActive(false), 3000);
      return () => clearTimeout(timer);
    }
    setIsCelebrationActive(false);
  }, [streak, hasCompletedToday, shouldCelebratePerfectWeek]);

  useEffect(() => {
    const subInterval = setInterval(() => {
      setSubtext(prev => {
        const idx = subtexts.indexOf(prev);
        return subtexts[(idx + 1) % subtexts.length];
      });
    }, 3000);

    const phraseInterval = setInterval(() => {
      const pool = streak > 7 ? strongPhrases : tensePhrases;
      setPhrase(prev => {
        const filtered = pool.filter(p => p !== prev);
        return filtered[Math.floor(Math.random() * filtered.length)];
      });
    }, 4500);

    return () => {
      clearInterval(subInterval);
      clearInterval(phraseInterval);
    };
  }, [streak]);

  // Weekly dots
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const todayIdx = (new Date().getDay() + 6) % 7; // 0-6 starting Monday

  // Variation intensity
  const intensityMultiplier = streak >= 100 ? 1.5 : (streak >= 30 ? 1.2 : 1);

  return (
    <motion.div
      key="streak_momentum"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8 }}
      className="absolute inset-0 z-50 flex flex-col items-center bg-[#FDFDFB] px-8 py-16"
    >
      <div className="absolute inset-0 z-0 opacity-20 mix-blend-multiply pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(#1C1C1E_1px,transparent_1px)] [background-size:20px_20px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      </div>

      {/* Header */}
      <div className="absolute top-12 left-0 right-0 px-8 flex items-center justify-between z-10">
        <button onClick={onBack} className="h-10 w-10 flex items-center justify-center rounded-full bg-white/60 border border-white/80 backdrop-blur-md shadow-sm active:scale-95 transition-all text-[#1A1A1A]">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div className="flex flex-col items-center">
          <span className="text-[13px] font-bold text-[#1C1C1E] uppercase tracking-[0.2em] opacity-80">momentum</span>
          <div className="w-8 h-0.5 bg-[#FF9F0A]/30 mt-1 rounded-full" />
        </div>
        <div className="w-10" />
      </div>

      {/* Main Content */}
      <div className="flex flex-1 flex-col items-center justify-center w-full">
        {/* Celebration Overlay Text */}
        <AnimatePresence>
          {isCelebrationActive && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 1.1, y: -20 }}
              className="absolute top-[20%] z-40"
            >
              <span className="text-[18px] font-bold text-[#FF9F0A] uppercase tracking-[0.3em] drop-shadow-[0_0_10px_rgba(255,159,10,0.4)]">
                {celebrationPhrases[Math.floor(Math.random() * celebrationPhrases.length)]}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Flame Element */}
        <div className="relative mb-12">
           <motion.div
             animate={{ 
               scale: isCelebrationActive ? [1, 1.15 * intensityMultiplier, 1] : [1, 1.08, 1],
               opacity: isCelebrationActive ? [0.9, 1, 0.9] : [0.9, 1, 0.9],
               filter: isCelebrationActive 
                 ? [`drop-shadow(0 0 15px rgba(255,159,10,${0.4 * intensityMultiplier}))`, `drop-shadow(0 0 40px rgba(255,159,10,${0.6 * intensityMultiplier}))`, `drop-shadow(0 0 15px rgba(255,159,10,${0.4 * intensityMultiplier}))`]
                 : ["drop-shadow(0 0 8px rgba(255,159,10,0.2))", "drop-shadow(0 0 25px rgba(255,159,10,0.4))", "drop-shadow(0 0 8px rgba(255,159,10,0.2))"]
             }}
             transition={{ 
               duration: isCelebrationActive ? 1.5 : 4, 
               repeat: Infinity, 
               ease: "easeInOut" 
             }}
             className="relative z-10"
           >
             <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A]">
               <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
             </svg>
           </motion.div>
           {/* Secondary Glow */}
           <div className={`absolute inset-x-0 -bottom-4 h-8 bg-[#FF9F0A] blur-[40px] transition-opacity duration-1000 -z-10 ${isCelebrationActive ? 'opacity-30' : 'opacity-10'}`} />
        </div>

        {/* Streak Number */}
        <motion.div
          initial={{ y: 15, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
          className="flex flex-col items-center"
        >
          <span className="text-[120px] font-medium tracking-tighter text-[#1C1C1E] leading-none mb-4">
            {streak}
          </span>
          <div className="h-6 flex items-center justify-center">
            <AnimatePresence mode="wait">
              <motion.span
                key={isCelebrationActive ? "perfect_week" : subtext}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                className={`text-[17px] font-medium tracking-tight ${isCelebrationActive ? 'text-[#FF9F0A]' : 'text-[#A1A1A6]'}`}
              >
                {isCelebrationActive ? "perfect week completed" : subtext}
              </motion.span>
            </AnimatePresence>
          </div>
        </motion.div>

        {/* Weekly Progression */}
        <div className="mt-20 w-full max-w-[300px]">
          <div className="flex justify-between items-end mb-10 px-1">
            {days.map((day, i) => {
              const isCurrent = i === todayIdx;
              const isCompleted = i < todayIdx || (i === todayIdx && hasCompletedToday);
              const isMissed = i < todayIdx && !isCompleted;

              return (
                <div key={i} className="flex flex-col items-center gap-4">
                  <span className={`text-[10px] font-bold tracking-[0.2em] transition-colors duration-500 ${isCelebrationActive ? 'text-[#FF9F0A]' : (isCurrent ? 'text-[#1C1C1E]' : 'text-[#A1A1A6] opacity-30')}`}>
                    {day}
                  </span>
                  <div className="relative">
                    <motion.div 
                      className={`w-1 h-1 rounded-full transition-all duration-1000 ${
                        isCompleted ? 'bg-[#FF9F0A]' : isMissed ? 'bg-[#A1A1A6] opacity-30' : 'bg-[#E5E5EA]'
                      }`}
                      style={isCompleted ? { boxShadow: isCelebrationActive ? `0 0 15px rgba(255,159,10,${0.9 * intensityMultiplier})` : '0 0 10px rgba(255,159,10,0.8)' } : {}}
                      animate={isCurrent && !hasCompletedToday ? { scale: [1, 1.6, 1], opacity: [0.4, 0.8, 0.4] } : (isCelebrationActive && isCompleted ? { scale: [1, 1.4, 1] } : {})}
                      transition={isCelebrationActive ? { duration: 0.8, delay: i * 0.1 } : { repeat: Infinity, duration: 2.5 }}
                    />
                    {isCurrent && (
                      <div className="absolute -inset-4 bg-[#FF9F0A]/5 blur-lg rounded-full -z-10" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Momentum Bar */}
          <div className="relative h-[2px] w-full bg-[#F2F2F7] rounded-full overflow-hidden">
             <motion.div 
               initial={{ width: 0 }}
               animate={{ 
                 width: `${Math.min(((streak % 7 || (streak > 0 ? 7 : 0)) / 7) * 100, 100)}%`,
                 opacity: isCelebrationActive ? [1, 0.6, 1] : 1,
                 backgroundColor: isCelebrationActive ? '#FFB340' : '#FF9F0A'
               }}
               transition={{ 
                 width: { duration: 2, ease: [0.22, 1, 0.36, 1], delay: 0.5 },
                 opacity: { duration: 1, repeat: isCelebrationActive ? Infinity : 0 }
               }}
               className="absolute inset-y-0 left-0 bg-[#FF9F0A] shadow-[0_0_12px_rgba(255,159,10,0.5)]"
             />
          </div>
          <div className="mt-4 flex justify-between items-center px-1">
            <span className="text-[9px] font-bold text-black uppercase tracking-[0.2em] opacity-100">weekly rhythm</span>
            <span className="text-[10px] font-bold text-black opacity-100 tracking-[0.1em]">LVL {Math.floor(streak / 7) + 1}</span>
          </div>
        </div>
      </div>

      {/* Motivational Phrase */}
      <div className="mt-auto pb-10 w-full flex justify-center h-12 items-center">
        <AnimatePresence mode="wait">
          <motion.p
            key={isCelebrationActive ? "celeb_phrase" : phrase}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.02 }}
            transition={{ duration: 1.5, ease: "easeInOut" }}
            className={`text-[15px] font-medium tracking-tight italic transition-colors duration-500 ${isCelebrationActive ? 'text-[#FF9F0A]' : 'text-[#1C1C1E] opacity-50'}`}
          >
            {isCelebrationActive ? "momentum confirmed." : phrase}
          </motion.p>
        </AnimatePresence>
      </div>

      {/* Backdrop Decorative Elements */}
      <motion.div 
        animate={isCelebrationActive ? { scale: [1, 1.2, 1], opacity: [0.05, 0.1, 0.05] } : {}}
        transition={{ duration: 3, repeat: Infinity }}
        className="absolute bottom-[-10%] right-[-10%] w-[70%] h-[50%] bg-[#FF9F0A]/5 blur-[120px] rounded-full pointer-events-none -z-10" 
      />
      <motion.div 
        animate={isCelebrationActive ? { scale: [1, 1.1, 1], opacity: [0.03, 0.06, 0.03] } : {}}
        transition={{ duration: 4, repeat: Infinity }}
        className="absolute top-[10%] left-[-15%] w-[50%] h-[40%] bg-[#FF9F0A]/3 blur-[100px] rounded-full pointer-events-none -z-10" 
      />
    </motion.div>
  );
}

function MissionContent({ mission, onComplete, onGoBack }: { mission: { title: string; instruction: string; duration: number; xp: number }; onComplete: () => void; onGoBack?: () => void; key?: string }) {
  const TOTAL_TIME = mission.duration;
  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [isCompleting, setIsCompleting] = useState(false);

  useEffect(() => {
    if (timeLeft <= 0 && !isCompleting) {
      setIsCompleting(true);
      onComplete();
      return;
    }
    if (!isCompleting) {
      const timer = setInterval(() => {
        setTimeLeft((prev) => prev - 1);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [timeLeft, onComplete, isCompleting]);

  return (
    <motion.div
      key="mission"
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-0 z-20 flex flex-col items-center bg-[#F9F9FB] px-8 py-16"
    >
      {/* Delicate organic background noise/gradient overlay */}
      <div className="absolute inset-0 z-0 opacity-40 mix-blend-multiply pointer-events-none">
        <div className="absolute -left-[20%] -top-[10%] h-[500px] w-[500px] rounded-full bg-[#EAEAEF] blur-[100px]" />
        <div className="absolute -right-[15%] top-[40%] h-[400px] w-[400px] rounded-full bg-[#E5E5ED] blur-[90px]" />
      </div>

      <div className="relative z-10 flex w-full flex-1 flex-col items-center justify-between">
        <motion.div
          key="active-mission"
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="flex w-full flex-1 flex-col items-center justify-between"
        >
          {/* Top minimal back button */}
          <div className="w-full flex justify-start -mt-4">
            {onGoBack && (
              <button 
                onClick={onGoBack}
                className="text-[15px] font-medium text-[#A1A1A6] tracking-tight hover:text-[#1C1C1E] transition-colors outline-none"
              >
                back
              </button>
            )}
          </div>

          {/* Mission Text (Upper Center) */}
          <div className="flex flex-col items-center text-center mt-[10vh]">
            <h2 className="text-[32px] font-medium leading-[1.2] tracking-[-0.03em] text-[#1C1C1E] mb-3">
              {mission.title}
            </h2>
            <p className="text-[18px] font-normal leading-[1.4] tracking-[-0.01em] text-[#A1A1A6] max-w-[85%]">
              {mission.instruction}
            </p>
          </div>

          {/* Discreet Timer (Lower Center) */}
          <div className="mb-20 flex flex-col items-center justify-center gap-5">
            {/* Thin progress line */}
            <div className="relative h-[2px] w-16 overflow-hidden rounded-full bg-black/5">
              <motion.div
                className="absolute bottom-0 left-0 top-0 bg-[#5C5CFF]"
                initial={{ width: "100%" }}
                animate={{ width: "0%" }}
                transition={{ duration: TOTAL_TIME, ease: "linear" }}
              />
            </div>
            
            {/* Number Display or Completion Check */}
            <div className="h-6 flex items-center justify-center relative w-full">
              <AnimatePresence mode="popLayout" initial={false}>
                {!isCompleting ? (
                  <motion.span
                    key={timeLeft}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.1 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                    className="absolute text-[13px] font-medium tracking-widest text-[#A1A1A6] uppercase tabular-nums"
                  >
                    {String(timeLeft).padStart(2, '0')}
                  </motion.span>
                ) : (
                  <motion.div
                    key="completion"
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 300, damping: 20 }}
                    className="absolute text-[#5C5CFF]"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

function RewardContent({ earnedXP, leveledUp, streak, streakIncreased, isCycleComplete, isFirstMission, isEarlyProgression, cycle, onContinue, onGoBack }: { earnedXP: number; leveledUp: boolean; streak: number; streakIncreased: boolean; isCycleComplete?: boolean; isFirstMission?: boolean; isEarlyProgression?: boolean; cycle?: number; onContinue: () => void; onGoBack: () => void; key?: string }) {
  const [rivalMsg, setRivalMsg] = useState("");

  const REWARD_MSG = ["nice.", "again?", "not bad.", "keep going.", "getting into it?"];
  const CYCLE_MSG = [cycle && cycle > 0 ? `round ${cycle + 1} 😏` : "round 2 😏", "again?", "let's go"];
  const FIRST_MISSION_MSG = ["good.", "there it is.", "you did it."];
  const EARLY_MSG = ["you're moving.", "already.", "good start.", "keep going."];

  useEffect(() => {
    let defaultMessages = REWARD_MSG;
    if (isFirstMission) defaultMessages = FIRST_MISSION_MSG;
    else if (isEarlyProgression) defaultMessages = EARLY_MSG;
    else if (isCycleComplete) defaultMessages = CYCLE_MSG;
    else if (leveledUp) defaultMessages = ["you're leveling up", "you're getting better"];

    const t1 = setTimeout(() => {
      setRivalMsg(defaultMessages[Math.floor(Math.random() * defaultMessages.length)]);
    }, 800);
    return () => clearTimeout(t1);
  }, [leveledUp, isCycleComplete, isFirstMission, isEarlyProgression]);

  return (
    <motion.div
      key="reward"
      initial={{ opacity: 0, filter: "blur(8px)", y: 10 }}
      animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
      exit={{ opacity: 0, filter: "blur(8px)", scale: 0.98 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-0 z-20 flex flex-col items-center bg-[#F9F9FB] px-8 py-20"
    >
      <RivalMessage text={rivalMsg} />
      {/* Background noise/gradient */}
      <div className="absolute inset-0 z-0 opacity-40 mix-blend-multiply pointer-events-none">
        <div className="absolute -left-[20%] -top-[10%] h-[500px] w-[500px] rounded-full bg-[#EAEAEF] blur-[100px]" />
        <div className="absolute -right-[15%] top-[40%] h-[400px] w-[400px] rounded-full bg-[#E5E5ED] blur-[90px]" />
      </div>

      <div className="relative z-10 flex w-full flex-1 flex-col items-center justify-center -mt-10">
        
        {/* Success or Level Up confirmation */}
        <motion.div
           initial={{ scale: 0.8, opacity: 0 }}
           animate={{ scale: 1, opacity: 1 }}
           transition={{ type: "spring", stiffness: 300, damping: 25, delay: 0.1 }}
           className={`mb-10 flex h-16 w-16 items-center justify-center rounded-full bg-white/60 backdrop-blur-md shadow-[inset_0_1px_2px_rgba(255,255,255,0.9),0_8px_16px_rgba(0,0,0,0.04)] border border-white/80 ${leveledUp ? 'text-[#FF9F0A]' : 'text-[#5C5CFF]'} relative`}
        >
          {leveledUp && (
             <motion.div
               initial={{ opacity: 0, scale: 0.9 }}
               animate={{ opacity: [0, 0.4, 0], scale: [1, 1.25, 1.4] }}
               transition={{ duration: 2, ease: "easeOut", delay: 0.2 }}
               className="absolute inset-0 bg-[#FF9F0A] rounded-full blur-md opacity-20 pointer-events-none"
             />
          )}
          {leveledUp ? (
            <motion.svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              initial={{ y: 5, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5, ease: "easeOut", delay: 0.3 }}
            >
              <polyline points="12 4 4 20 12 16 20 20 12 4" />
            </motion.svg>
          ) : (
            <motion.svg 
              xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
            >
              <motion.polyline points="20 6 9 17 4 12" />
            </motion.svg>
          )}
        </motion.div>

        {/* XP Reward (Light Claymorphism + Soft Glow) */}
        <div className="relative mb-4">
          {leveledUp && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: [0, 0.4, 0], scale: [1, 1.15, 1.25] }}
              transition={{ duration: 2, ease: "easeOut", delay: 0.4 }}
              className="absolute inset-0 rounded-3xl bg-[#5C5CFF] blur-xl opacity-20 pointer-events-none"
            />
          )}
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ 
              scale: [1, 1.05, 1],
              opacity: 1
            }}
            transition={{ 
              scale: {
                duration: 1.2,
                repeat: Infinity,
                repeatDelay: 3.8,
                ease: "easeInOut",
                delay: 1.5
              },
              opacity: { duration: 1.2, delay: 0.2 }
            }}
            className="relative px-8 py-4 rounded-3xl bg-[#F0F0FF] flex items-center justify-center border border-white/60"
            style={{ boxShadow: leveledUp ? 'inset 2px 2px 4px #ffffff, inset -2px -2px 6px #d4d4f7, 0 8px 32px rgba(92, 92, 255, 0.4)' : 'inset 2px 2px 4px #ffffff, inset -2px -2px 6px #d4d4f7, 0 8px 24px rgba(92, 92, 255, 0.15)' }}
          >
            <AnimatedXP value={earnedXP} />
          </motion.div>
        </div>

        {streakIncreased && (
          <motion.div
            initial={{ y: 5, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8, ease: "easeOut", delay: 0.6 }}
            className="mb-4 flex items-center justify-center gap-1.5"
          >
             <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A] opacity-80"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
             <span className="text-[14px] font-medium text-[#A1A1A6] tracking-tight">{streak} days streak</span>
          </motion.div>
        )}
      </div>

      {/* Buttons */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.7 }}
        className="w-full flex flex-col gap-2 z-10 pb-8"
      >
        <button
          onClick={onContinue}
          className="w-full py-[18px] rounded-full bg-[#1C1C1E] text-white text-[15px] font-medium tracking-wide shadow-[0_8px_16px_rgba(0,0,0,0.1)] active:scale-[0.98] transition-all"
        >
          next
        </button>
        <button
          onClick={onGoBack}
          className="w-full py-4 rounded-full bg-transparent text-[#A1A1A6] text-[15px] font-medium tracking-wide hover:text-[#1C1C1E] active:scale-[0.98] transition-all"
        >
          go back
        </button>
      </motion.div>
    </motion.div>
  );
}

function ChallengeLobbyContent({ onBack, onStartMatch }: { onBack: () => void; onStartMatch: (opponent: string) => void; key?: string }) {
  const [copied, setCopied] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const [status, setStatus] = useState<"waiting" | "generating_link" | "invite_failed" | "joined" | "match_failed">("waiting");

  const emptyStateText = useMemo(() => {
    const options = ["someone needs to lose.", "waiting for your first rival.", "start something.", "challenge someone.", "don't play alone."];
    return options[Math.floor(Math.random() * options.length)];
  }, []);

  const waitingText = useMemo(() => {
    const options = ["waiting...", "challenge sent.", "waiting for a response.", "let's see if he accepts."];
    return options[Math.floor(Math.random() * options.length)];
  }, []);

  const acceptedText = useMemo(() => {
    const options = ["challenge accepted.", "it's on.", "game time."];
    return options[Math.floor(Math.random() * options.length)];
  }, []);

  useEffect(() => {
    setInviteLink(`levelup.app/play/${Math.random().toString(36).substring(2, 7)}`);
  }, []);

  const handleShare = () => {
    if (Math.random() < 0.1) {
      setStatus("invite_failed");
      return;
    }

    navigator.clipboard.writeText(inviteLink).catch(()=>{});
    setCopied(true);
    setStatus("waiting");
    
    setTimeout(() => {
      setStatus("joined");
      
      setTimeout(() => {
        if (Math.random() < 0.05) {
          setStatus("match_failed");
        } else {
          onStartMatch("Alex");
        }
      }, 1500);
    }, 2500);
  };

  return (
    <motion.div
      key="challenge_lobby"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8 }}
      className="absolute inset-0 z-30 flex flex-col items-center justify-between bg-[#FDFDFB] px-8 py-16"
    >
      <div className="absolute inset-0 z-0 opacity-20 mix-blend-multiply pointer-events-none">
         <div className="absolute top-[20%] left-[50%] -translate-x-1/2 h-[300px] w-[300px] rounded-full bg-[#EAEAEF] blur-[100px]" />
      </div>

      <div className="w-full flex justify-between items-center relative z-10 px-1">
        <button onClick={onBack} className="h-10 w-10 flex items-center justify-center rounded-full bg-white/60 border border-white/80 backdrop-blur-md shadow-sm active:scale-95 transition-all text-[#1A1A1A]">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div className="flex flex-col items-center">
          <span className="text-[15px] font-medium text-[#1C1C1E]">1v1 Duel</span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className="w-1 h-1 rounded-full bg-[#34C759] shadow-[0_0_4px_#34C759]" />
            <span className="text-[10px] font-bold text-[#A1A1A6] uppercase tracking-[0.1em]">social active</span>
          </div>
        </div>
        <div className="w-10 h-10" />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center relative z-10 w-full text-center px-4">
        <AnimatePresence mode="wait">
          {status === "waiting" && (
            <motion.div key="waiting" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
              <h2 className="text-[32px] font-medium leading-[1.1] tracking-tight text-[#1C1C1E]">
                {emptyStateText}
              </h2>
              <p className="mt-4 text-[15px] font-medium text-[#A1A1A6] opacity-70">
                send a link and start a duel.
              </p>
            </motion.div>
          )}

          {status === "joined" && (
            <motion.div key="joined" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex flex-col items-center">
               <div className="relative mb-6">
                 <div className="w-20 h-20 rounded-full bg-[#1C1C1E] flex items-center justify-center text-white text-xl font-medium border-4 border-white shadow-xl">
                   A
                 </div>
                 <div className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-[#34C759] border-2 border-white" />
               </div>
               <h2 className="text-[32px] font-medium leading-[1.1] tracking-tight text-[#1C1C1E]">
                  {acceptedText}
               </h2>
               <p className="mt-4 text-[15px] font-medium text-[#A1A1A6]">
                  Alex is in.
               </p>
            </motion.div>
          )}

          {status === "invite_failed" && (
            <motion.div key="invite_failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <h2 className="text-[28px] font-medium leading-[1.2] tracking-tight text-[#1C1C1E]">
                invite failed
              </h2>
              <p className="mt-4 text-[15px] font-medium text-[#A1A1A6]">
                something went wrong.
              </p>
            </motion.div>
          )}

          {status === "match_failed" && (
            <motion.div key="match_failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <h2 className="text-[28px] font-medium leading-[1.2] tracking-tight text-[#1C1C1E]">
                match failed
              </h2>
              <p className="mt-4 text-[15px] font-medium text-[#A1A1A6]">
                connection dropped.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <motion.div className="w-full mt-auto pb-4 z-10 space-y-3">
        {status === "waiting" && (
          <motion.div key="btn_waiting" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 w-full">
            <div className="mx-auto w-[240px] px-4 py-3 rounded-2xl bg-white shadow-[0_10px_30px_rgba(0,0,0,0.04),inset_0_-2px_4px_rgba(0,0,0,0.02)] border border-white flex items-center justify-center">
              <span className="text-[13px] font-mono font-medium text-[#1C1C1E]/40 truncate">{inviteLink}</span>
            </div>
            <button
              onClick={handleShare}
              className="w-full h-[64px] rounded-full bg-[#1C1C1E] text-white flex items-center justify-center gap-2 shadow-[0_12px_24px_rgba(0,0,0,0.12)] active:scale-[0.98] transition-all"
            >
              <span className="text-[16px] font-medium tracking-wide">{copied ? "link copied" : "share challenge"}</span>
            </button>
          </motion.div>
        )}
        
        {(status === "invite_failed" || status === "match_failed") && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3 w-full">
            <button
              onClick={() => setStatus("waiting")}
              className="w-full h-[64px] rounded-full bg-[#1C1C1E] text-white flex items-center justify-center gap-2 shadow-[0_12px_24px_rgba(0,0,0,0.12)] active:scale-[0.98] transition-all"
            >
              <span className="text-[16px] font-medium tracking-wide">try again</span>
            </button>
          </motion.div>
        )}

        {status === "joined" && (
           <div className="h-[64px] w-full" /> 
        )}
      </motion.div>
    </motion.div>
  );
}

function Match1v1Content({ opponentName, userStreak, onFinish }: { opponentName: string; userStreak: number; onFinish: (userScore: number, opponentScore: number) => void; key?: string }) {
  const [userScore, setUserScore] = useState(0);
  const [opponentScore, setOpponentScore] = useState(0);
  const [feedback, setFeedback] = useState("first to 3 wins!");
  const [isFinished, setIsFinished] = useState(false);
  const [streakComparison, setStreakComparison] = useState("");

  useEffect(() => {
    // Generate a believable opponent streak difference
    const diff = Math.floor(Math.random() * 5) - 1; // Between -1 and 3
    if (diff > 0) {
      setStreakComparison(`${diff} more day${diff > 1 ? 's' : ''} than ${opponentName}`);
    } else if (diff === 0) {
      setStreakComparison(`tied streak with ${opponentName}`);
    } else {
      setStreakComparison(`1 day behind ${opponentName}`);
    }
  }, [userStreak, opponentName]);

  const MATCH_MISSIONS = [
    { title: "Snap Out", instruction: "Clap your hands once." },
    { title: "Shoulder Reset", instruction: "Roll your shoulders." },
    { title: "Micro Move", instruction: "Stand up." },
    { title: "Eye Reset", instruction: "Look away for 3s." },
    { title: "Breath Lock", instruction: "Take one deep breath." },
    { title: "Name It", instruction: "Say your name out loud." }
  ];
  
  const [currentMission, setCurrentMission] = useState(MATCH_MISSIONS[0]);

  useEffect(() => {
    if (userScore >= 3 || opponentScore >= 3) {
      if (!isFinished) {
        setIsFinished(true);
        setTimeout(() => onFinish(userScore, opponentScore), 500);
      }
    }
  }, [userScore, opponentScore, onFinish, isFinished]);

  useEffect(() => {
    if (isFinished) return;
    const interval = Math.random() * 3000 + 4000; 
    const t = setTimeout(() => {
      setOpponentScore(v => {
        const next = v + 1;
        if (next === 1) setFeedback("he completed 1 mission");
        else if (next > userScore) setFeedback("he passed you 😏");
        else if (next === userScore) setFeedback("tied up!");
        return next;
      });
    }, interval);
    return () => clearTimeout(t);
  }, [opponentScore, isFinished, userScore]);

  return (
    <motion.div
      key="match_1v1"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="absolute inset-0 z-30 flex flex-col items-center justify-between bg-[#FDFDFB] px-8 py-16"
    >
      <div className="absolute inset-0 z-0 opacity-20 mix-blend-multiply pointer-events-none">
         <div className="absolute -top-[10%] left-[50%] -translate-x-1/2 h-[400px] w-[400px] rounded-full bg-[#EAEAEF] blur-[100px]" />
      </div>

      <div className="w-full relative z-10 flex justify-between px-2 pt-6">
         <div className="flex flex-col items-start w-24">
            <span className="text-[12px] uppercase font-bold tracking-widest text-[#A1A1A6] mb-1">You</span>
            <span className="text-[32px] font-semibold text-[#1C1C1E] leading-none">{userScore}/3</span>
         </div>
         <div className="flex flex-col items-end w-max">
            <span className="text-[12px] uppercase font-bold tracking-widest text-[#A1A1A6] mb-1 text-right">{opponentName}</span>
            <span className="text-[32px] font-semibold text-[#1C1C1E] leading-none text-right">{opponentScore}/3</span>
         </div>
      </div>
      
      {streakComparison && (
        <div className="w-full flex justify-end px-2 mt-2 relative z-10">
          <span className="text-[11px] font-medium text-[#A1A1A6]">{streakComparison}</span>
        </div>
      )}

      <div className="w-full flex gap-3 mt-6 px-2 relative z-10">
        <div className="flex-1 h-2.5 bg-black/5 rounded-full overflow-hidden relative border border-black/5">
           <motion.div animate={{ width: `${Math.min((userScore / 3) * 100, 100)}%` }} className="absolute left-0 top-0 bottom-0 bg-[#5C5CFF] rounded-full" />
        </div>
        <div className="flex-1 h-2.5 bg-black/5 rounded-full overflow-hidden relative border border-black/5 flex justify-end">
           <motion.div animate={{ width: `${Math.min((opponentScore / 3) * 100, 100)}%` }} className="absolute right-0 top-0 bottom-0 bg-[#1C1C1E] rounded-full" />
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center w-full relative z-10">
         <div className="h-12 flex flex-col items-center justify-center mb-8">
           <AnimatePresence mode="popLayout">
             <motion.p
               key={feedback}
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, y: -10 }}
               className="text-[15px] font-medium text-[#A1A1A6] text-center"
             >
               {feedback}
             </motion.p>
           </AnimatePresence>
         </div>

         <div className="flex flex-col items-center justify-center -mt-4 mb-12">
             <motion.div
               key={currentMission.title}
               initial={{ opacity: 0, scale: 0.95, y: 10 }}
               animate={{ opacity: 1, scale: 1, y: 0 }}
               transition={{ duration: 0.2 }}
               className="flex flex-col items-center"
             >
               <h2 className="text-[32px] font-medium text-[#1C1C1E] tracking-tight text-center mb-2">
                 {currentMission.title}
               </h2>
               <p className="text-[17px] font-normal text-[#A1A1A6] text-center px-4 leading-[1.3]">
                 {currentMission.instruction}
               </p>
             </motion.div>
         </div>

         <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={() => {
              if (isFinished) return;
              setUserScore(v => {
                const next = v + 1;
                if (next > opponentScore && next < 3) setFeedback("you're ahead");
                else if (next === 3) setFeedback("you got him 😏");
                return next;
              });
              setCurrentMission(MATCH_MISSIONS[Math.floor(Math.random() * MATCH_MISSIONS.length)]);
            }}
            className="w-full h-[64px] rounded-full bg-[#1C1C1E] text-white flex items-center justify-center shadow-[0_8px_24px_rgba(0,0,0,0.12)] active:bg-[#2C2C2E] transition-colors outline-none cursor-pointer"
         >
            <span className="text-[18px] font-medium tracking-wide">done</span>
         </motion.button>
      </div>
    </motion.div>
  );
}

function MatchResultContent({ userScore, opponentScore, opponentName, onRematch, onInvite, onHome }: { userScore: number; opponentScore: number; opponentName: string; onRematch: () => void; onInvite: () => void; onHome: () => void; key?: string }) {
  const won = userScore > opponentScore;
  const draw = userScore === opponentScore;

  const phrase = useMemo(() => {
    const victoryPhrases = ["not even close.", "too fast.", "easy.", "locked in.", "clean win."];
    const defeatPhrases = ["too slow.", "not enough.", "he got you.", "almost.", "missed your shot."];
    const drawPhrases = ["again?", "unfinished.", "too close.", "no winner."];
    
    if (draw) return drawPhrases[Math.floor(Math.random() * drawPhrases.length)];
    return won 
      ? victoryPhrases[Math.floor(Math.random() * victoryPhrases.length)]
      : defeatPhrases[Math.floor(Math.random() * defeatPhrases.length)];
  }, [won, draw]);

  const rematchText = useMemo(() => {
    const options = ["run it back", "again.", "one more.", "redo it."];
    return options[Math.floor(Math.random() * options.length)];
  }, []);

  return (
    <motion.div
      key="match_result"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
      className="absolute inset-0 z-30 flex flex-col items-center justify-between bg-[#FDFDFB] px-8 py-16"
    >
      <div className="absolute inset-0 z-0 opacity-40 mix-blend-multiply pointer-events-none">
         <div className="absolute top-[25%] left-[50%] -translate-x-1/2 h-[350px] w-[350px] rounded-full bg-[#EAEAEF] blur-[110px]" />
      </div>

      <div className="w-full flex justify-end relative z-10">
         <button onClick={onHome} className="h-10 w-10 flex items-center justify-center rounded-full bg-white/40 border border-white/60 backdrop-blur-md shadow-sm text-[#1A1A1A] active:scale-95 transition-all outline-none">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
         </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center relative z-10 w-full mb-12">
         <motion.h1 
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            className="text-[42px] font-medium text-[#1C1C1E] tracking-tight leading-tight text-center"
         >
            {phrase}
         </motion.h1>
         
         <motion.div 
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center gap-12 mt-20"
         >
            <div className={`flex flex-col items-center transition-opacity duration-700 ${!won && !draw ? 'opacity-40' : 'opacity-100'}`}>
               <span className="text-[11px] font-bold text-[#A1A1A6] uppercase tracking-[0.2em] mb-4">you</span>
               <span className={`text-[80px] font-medium leading-none tracking-tighter ${won ? 'text-[#5C5CFF]' : 'text-[#1C1C1E]'}`}>{userScore}</span>
            </div>
            
            <div className="h-12 w-[1px] bg-black/5 self-end mb-6" />

            <div className={`flex flex-col items-center transition-opacity duration-700 ${won ? 'opacity-40' : 'opacity-100'}`}>
               <span className="text-[11px] font-bold text-[#A1A1A6] uppercase tracking-[0.2em] mb-4 truncate max-w-[80px] text-center">{opponentName}</span>
               <span className={`text-[80px] font-medium leading-none tracking-tighter ${!won && !draw ? 'text-[#5C5CFF]' : 'text-[#1C1C1E]'}`}>{opponentScore}</span>
            </div>
         </motion.div>
      </div>

      <motion.div 
         initial={{ y: 20, opacity: 0 }}
         animate={{ y: 0, opacity: 1 }}
         transition={{ duration: 0.8, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
         className="w-full flex flex-col gap-3 pb-4 relative z-10"
      >
         <button onClick={onRematch} className="w-full h-[64px] rounded-full bg-[#1C1C1E] text-white text-[16px] font-medium tracking-wide shadow-[0_12px_24px_rgba(0,0,0,0.12)] active:scale-[0.98] transition-all">
            {rematchText}
         </button>
         <button onClick={onInvite} className="w-full h-[64px] rounded-full bg-white text-[#1C1C1E] text-[15px] font-medium tracking-wide border border-black/5 active:scale-[0.98] transition-all">
            invite someone else
         </button>
      </motion.div>
    </motion.div>
  );
}

function Onboarding1Content({ onNext }: { onNext: () => void; key?: string }) {
  return (
    <motion.div
      key="onboarding1"
      initial={{ opacity: 0, filter: "blur(8px)", scale: 0.98 }}
      animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
      exit={{ opacity: 0, filter: "blur(8px)", x: -20, scale: 0.98 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-0 z-30 flex flex-col items-center justify-between bg-[#FDFDFB] px-8 py-16"
    >
      <div className="absolute inset-0 z-0 opacity-30 mix-blend-multiply pointer-events-none">
        <div className="absolute -left-[10%] top-[10%] h-[400px] w-[400px] rounded-full bg-[#EAEAEF] blur-[100px]" />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center relative z-10 w-full text-center mt-10">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.8, ease: "easeOut", delay: 0.2 }}
          className="mb-8 flex h-16 w-16 items-center justify-center rounded-full bg-white/60 backdrop-blur-md shadow-[inset_0_1px_2px_rgba(255,255,255,0.9),0_8px_16px_rgba(0,0,0,0.04)] border border-white/80"
        >
          <motion.div
            animate={{ scale: [1, 1.25, 1], opacity: [1, 0.7, 1] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            className="w-5 h-5 rounded-full bg-[#5C5CFF] shadow-[0_0_15px_rgba(92,92,255,0.5)]"
          />
        </motion.div>
        
        <motion.h1 
          initial={{ y: 15, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="text-[34px] font-normal tracking-[-0.03em] text-[#1C1C1E] leading-[1.1]"
        >
          Take back control
        </motion.h1>
        <motion.p 
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="text-[17px] text-[#A1A1A6] font-medium tracking-[-0.01em] mt-3"
        >
          one quick tap at a time
        </motion.p>
      </div>

      <motion.div 
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full relative z-10 pb-4"
      >
        <button 
          onClick={onNext} 
          className="w-full py-[18px] rounded-full bg-[#1C1C1E] text-white text-[16px] font-medium tracking-wide shadow-[0_8px_20px_rgba(0,0,0,0.1)] active:scale-[0.98] transition-all flex items-center justify-center gap-2"
        >
          <span>go</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-70"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        </button>
      </motion.div>
    </motion.div>
  );
}

function Onboarding2Content({ onComplete }: { onComplete: () => void; key?: string }) {
  return (
    <motion.div
      key="onboarding2"
      initial={{ opacity: 0, x: 20, filter: "blur(8px)", scale: 0.98 }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)", scale: 1 }}
      exit={{ opacity: 0, filter: "blur(8px)", scale: 0.98 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-0 z-30 flex flex-col items-center justify-between bg-[#FDFDFB] px-8 py-16"
    >
      <div className="absolute inset-0 z-0 opacity-40 mix-blend-multiply pointer-events-none">
         <div className="absolute right-[10%] bottom-[20%] h-[400px] w-[400px] rounded-full bg-[#EAEAEF] blur-[100px]" />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center relative z-10 w-full text-center mt-10">
        <motion.div
          initial={{ y: 20, scale: 0.9, opacity: 0 }}
          animate={{ y: 0, scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.1 }}
          className="mb-8 px-6 py-3 rounded-2xl bg-[#F0F0FF] border border-white/60 flex items-center justify-center"
          style={{ boxShadow: 'inset 2px 2px 4px #ffffff, inset -2px -2px 6px #d4d4f7, 0 8px 24px rgba(92, 92, 255, 0.15)' }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#5C5CFF]"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </motion.div>
        
        <motion.h1 
          initial={{ y: 15, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="text-[34px] font-normal tracking-[-0.03em] text-[#1C1C1E] leading-[1.1]"
        >
          <span className="text-[#A1A1A6]">small moves,</span><br/>
          <span className="font-medium">big reset</span>
        </motion.h1>
      </div>

      <motion.div 
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="w-full relative z-10 pb-4"
      >
        <button 
          onClick={onComplete} 
          className="w-full py-[18px] rounded-full bg-[#5C5CFF] text-white text-[16px] font-semibold tracking-wide shadow-[0_8px_24px_rgba(92,92,255,0.25)] active:scale-[0.98] transition-all flex items-center justify-center"
        >
          Level Up now
        </button>
      </motion.div>
    </motion.div>
  );
}

function SettingsGroup({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div className="mb-8 w-full">
      <h3 className="text-[11px] font-bold text-white/40 uppercase tracking-[0.15em] mb-3 px-4">{title}</h3>
      <div className="bg-white/5 rounded-3xl overflow-hidden flex flex-col border border-white/5 shadow-sm">
        {children}
      </div>
    </div>
  );
}

function SettingsItem({ label, value, onClick, isLast }: { label: string, value?: string, onClick?: () => void, isLast?: boolean }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex justify-between items-center px-5 py-4 outline-none active:bg-white/5 transition-colors text-left ${!isLast ? 'border-b border-white/5' : ''}`}
    >
      <span className="text-[15px] font-medium text-white/90">{label}</span>
      <div className="flex items-center gap-2">
        {value && <span className="text-[14px] font-medium text-white/40">{value}</span>}
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-30 text-white"><path d="m9 18 6-6-6-6"/></svg>
      </div>
    </button>
  );
}

function ProfileContent({ totalXP, streak, longestStreak, completedMissions, onBack, user }: { totalXP: number; streak: number; longestStreak: number; completedMissions: number; onBack: () => void; user: User | null; key?: string }) {
  const level = Math.floor(totalXP / 100);
  const currentLevelXP = totalXP % 100;
  const nextLevelXP = 100;
  const progressPercentage = (currentLevelXP / nextLevelXP) * 100;

  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState(user?.displayName || "Player");
  
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [tempUsername, setTempUsername] = useState("@player");

  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [tempEmail, setTempEmail] = useState(user?.email || "");

  const [isEditingPassword, setIsEditingPassword] = useState(false);
  const [tempPasswordCurrent, setTempPasswordCurrent] = useState("");
  const [tempPasswordNew, setTempPasswordNew] = useState("");

  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [tempPhone, setTempPhone] = useState("");

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSavedToast, setShowSavedToast] = useState("");

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState("Profile");

  const [tempAvatar, setTempAvatar] = useState(user?.photoURL || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setTempAvatar(url);
      triggerSave("Avatar");
    }
  };

  const triggerSave = (field: string) => {
    setShowSavedToast(field);
    setTimeout(() => setShowSavedToast(""), 2000);
  };

  const [isConnecting, setIsConnecting] = useState(false);
  const [connectSuccess, setConnectSuccess] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [showSavedFeedback, setShowSavedFeedback] = useState(false);
  const [showQRCode, setShowQRCode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfileSubpage, setShowProfileSubpage] = useState(false);
  const [showExpNotifications, setShowExpNotifications] = useState(false);
  const [showExpHaptics, setShowExpHaptics] = useState(false);
  const [showExpMessageStyle, setShowExpMessageStyle] = useState(false);

  const [showSocialFriends, setShowSocialFriends] = useState(false);
  const [showSocial1v1, setShowSocial1v1] = useState(false);
  const [showSocialRanking, setShowSocialRanking] = useState(false);
  const [showSocialPresence, setShowSocialPresence] = useState(false);

  const [expNotificationDaily, setExpNotificationDaily] = useState(true);
  const [expNotificationStreak, setExpNotificationStreak] = useState(true);
  const [expNotification1v1, setExpNotification1v1] = useState(true);
  const [expNotificationSocial, setExpNotificationSocial] = useState(true);
  
  const [expHapticsLevel, setExpHapticsLevel] = useState<"Off" | "Subtle" | "Strong">("Subtle");
  const [expMessageStyle, setExpMessageStyle] = useState<"Minimal" | "Balanced" | "Provocative">("Balanced");

  const [social1v1Setting, setSocial1v1Setting] = useState<"Everyone" | "Friends Only" | "No One">("Everyone");
  const [socialRankingSetting, setSocialRankingSetting] = useState<"Public" | "Friends Only" | "Private">("Public");
  const [socialPresenceSetting, setSocialPresenceSetting] = useState<"Online" | "Active Now" | "In Challenge" | "Waiting" | "Offline">("Active Now");

  const [showPrivacyProfile, setShowPrivacyProfile] = useState(false);
  const [showPrivacyActivity, setShowPrivacyActivity] = useState(false);
  const [showPrivacyOnline, setShowPrivacyOnline] = useState(false);
  const [showPrivacyInvisible, setShowPrivacyInvisible] = useState(false);

  const [privacyProfileVisibility, setPrivacyProfileVisibility] = useState<"Public" | "Friends" | "Private">("Friends");
  
  const [privacyActivityStreak, setPrivacyActivityStreak] = useState(true);
  const [privacyActivityRanking, setPrivacyActivityRanking] = useState(true);
  const [privacyActivityRecent, setPrivacyActivityRecent] = useState(true);
  const [privacyActivityChallenges, setPrivacyActivityChallenges] = useState(true);

  const [privacyOnlineStatus, setPrivacyOnlineStatus] = useState(true);
  const [privacyInvisibleMode, setPrivacyInvisibleMode] = useState(false);

  const [privacyConfirmModal, setPrivacyConfirmModal] = useState<{
    show: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
  }>({ show: false, title: "", description: "", onConfirm: () => {} });

  const [showSupportHelpCenter, setShowSupportHelpCenter] = useState(false);
  const [showSupportFeedback, setShowSupportFeedback] = useState(false);
  const [showSupportReportProblem, setShowSupportReportProblem] = useState(false);

  const [expandedHelpTopic, setExpandedHelpTopic] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [reportText, setReportText] = useState("");
  const [supportSubmitState, setSupportSubmitState] = useState<{show: boolean, msg: string}>({show: false, msg: ""});

  const [copied, setCopied] = useState(false);
  const [socialRank, setSocialRank] = useState<{ status: string; percentage: number | null }>({ status: "warming up", percentage: null });

  const ROTATING_MESSAGES = [
    "keep going",
    "still here 😏",
    "not bad",
    "you're moving",
    "again?"
  ];

  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    let status = "getting started";
    let pct = null;

    if (streak > 0 && streak <= 3) {
      if (streak === 1) status = "you're moving";
      else if (streak === 2) status = "not bad";
      else status = "warming up";
    } else if (streak > 3 && streak <= 10) {
      if (streak <= 5) status = "building momentum";
      else if (streak <= 7) status = "getting serious";
      else status = "locked in";
      pct = Math.min(85, 40 + streak * 4);
    } else if (streak > 10) {
      if (streak <= 15) status = "ahead of most";
      else if (streak <= 30) status = "unstoppable";
      else status = "dangerous consistency";
      pct = Math.min(99, 80 + Math.floor(streak * 0.5));
    }
    setSocialRank({ status, percentage: pct });
  }, [streak]);

  useEffect(() => {
    const interval = setInterval(() => {
      setMessageIndex((prev) => (prev + 1) % ROTATING_MESSAGES.length);
    }, 7000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (user?.displayName) setTempName(user.displayName);
  }, [user]);

  const handleSendLink = async () => {
    const url = user?.uid ? `https://levelup.app/u/${user.uid}` : "https://levelup.app";
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Add me on Level Up',
          url: url
        });
      } catch (err) {
        console.error(err);
      }
    } else {
      handleCopyLink();
    }
  };

  const handleCopyLink = () => {
    const url = user?.uid ? `https://levelup.app/u/${user.uid}` : "https://levelup.app";
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveName = async () => {
    if (!tempName.trim()) return;
    setIsEditingName(false);
    
    if (user) {
      try {
        await setDoc(doc(db, 'users', user.uid), {
          displayName: tempName
        }, { merge: true });
        setShowSavedFeedback(true);
        setTimeout(() => setShowSavedFeedback(false), 2000);
      } catch (e) {
        console.error(e);
      }
    } else {
      setShowSavedFeedback(true);
      setTimeout(() => setShowSavedFeedback(false), 2000);
    }
  };

  const handleLogin = async () => {
    setIsConnecting(true);
    setConnectError("");
    try {
      await linkGoogle();
      setConnectSuccess(true);
      setTimeout(() => setConnectSuccess(false), 2000);
    } catch (e) {
      console.error(e);
      setConnectError("Couldn't connect account. Try again.");
      setTimeout(() => setConnectError(""), 3000);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <motion.div
      key="profile"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: 15 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="absolute inset-0 z-30 flex flex-col bg-[#FDFDFB] overflow-y-auto"
    >
      {/* Background Orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute top-[-10%] right-[-10%] w-[400px] h-[400px] bg-[#5C5CFF]/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[20%] left-[-10%] w-[300px] h-[300px] bg-[#1C1C1E]/5 blur-[100px] rounded-full" />
      </div>

      {/* Confirmation Feedback */}
      <AnimatePresence>
        {showSavedFeedback && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 bg-black/5 backdrop-blur-md px-4 py-1.5 rounded-full z-[100] pointer-events-none"
          >
            <span className="text-[11px] font-bold text-[#1C1C1E] tracking-tight uppercase">saved</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* TOP HEADER */}
      <div className="relative z-10 px-8 pt-16 flex items-center justify-between">
        <button 
          onClick={onBack}
          className="h-10 w-10 flex items-center justify-center rounded-full bg-white/40 border border-black/5 active:scale-95 transition-all text-[#1C1C1E] backdrop-blur-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>

        <button 
          onClick={() => setShowSettings(true)}
          className="h-10 w-10 flex items-center justify-center rounded-full bg-white/40 border border-black/5 active:scale-95 transition-all text-[#1C1C1E] backdrop-blur-sm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-60"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.1a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>

      {/* IDENTITY SECTION */}
      <div className="relative z-10 flex flex-col items-center mt-8 px-8">
        <motion.div 
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className={`h-24 w-24 rounded-full border border-black/5 bg-white shadow-xl overflow-hidden flex items-center justify-center relative mb-6 ${user ? 'ring-4 ring-[#5C5CFF]/10' : ''}`}
        >
          {user?.photoURL ? (
            <img src={user.photoURL} alt="Avatar" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`${user ? 'text-[#5C5CFF]' : 'opacity-40'}`}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          )}
        </motion.div>

        <div className="flex flex-col items-center text-center">
          {isEditingName ? (
            <input 
              autoFocus
              type="text"
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
              className="text-[28px] font-semibold text-[#1C1C1E] bg-white border-b-2 border-[#5C5CFF] outline-none w-48 text-center px-2 py-1"
            />
          ) : (
            <h2 
              onClick={() => setIsEditingName(true)}
              className="text-[28px] font-semibold text-[#1C1C1E] tracking-tight cursor-pointer hover:opacity-80 transition-opacity"
            >
              {tempName}
            </h2>
          )}
          <span className="text-[14px] font-medium text-[#5C5CFF] mt-1 tracking-wide uppercase opacity-80 decoration-[1.5px]">
            {socialRank.status}
          </span>
        </div>
      </div>

      {/* PROGRESS SECTION */}
      <div className="relative z-10 px-8 mt-12 grid grid-cols-1 gap-12">
        <div className="flex flex-col items-center">
           <span className="text-[42px] font-bold tracking-tighter text-[#1C1C1E] leading-none mb-4">
             Level {String(level).padStart(2, '0')}
           </span>
           <div className="w-full max-w-[280px] flex flex-col gap-3">
             <div className="h-2 w-full bg-black/[0.03] rounded-full overflow-hidden shadow-inner">
               <motion.div 
                 initial={{ width: 0 }}
                 animate={{ width: `${progressPercentage}%` }}
                 transition={{ duration: 1.5, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
                 className="h-full bg-[#1C1C1E] rounded-full"
               />
             </div>
             <div className="w-full flex justify-center">
               <span className="text-[13px] font-medium text-[#A1A1A6] tabular-nums tracking-wide">
                 {currentLevelXP} / {nextLevelXP} XP
               </span>
             </div>
           </div>
        </div>
      </div>

      {/* OVERVIEW SECTION */}
      <div className="relative z-10 px-8 mt-16 pb-8">
        <h3 className="text-[13px] font-bold text-[#A1A1A6] uppercase tracking-[0.1em] mb-6 px-1">Overview</h3>
        
        <div className="space-y-4">
          {/* Streak Card */}
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="p-6 rounded-[32px] bg-white border border-black/[0.03] shadow-[0_8px_40px_rgba(0,0,0,0.01)]"
          >
            <div className="flex justify-between items-start mb-1">
              <span className="text-[18px] font-semibold text-[#1C1C1E]">{streak} days in a row</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A]"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
            </div>
            <p className="text-[13px] font-medium text-[#A1A1A6]">
              {socialRank.status}{socialRank.percentage ? ` · ahead of ${socialRank.percentage}%` : ""}
            </p>
          </motion.div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-4">
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
              className="p-6 rounded-[32px] bg-white border border-black/[0.03] shadow-[0_8px_40px_rgba(0,0,0,0.01)]"
            >
              <span className="block text-[22px] font-bold text-[#1C1C1E]">{completedMissions}</span>
              <span className="text-[12px] font-medium text-[#A1A1A6] mt-0.5">Missions</span>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 }}
              className="p-6 rounded-[32px] bg-white border border-black/[0.03] shadow-[0_8px_40px_rgba(0,0,0,0.01)]"
            >
              <span className="block text-[22px] font-bold text-[#1C1C1E]">{totalXP}</span>
              <span className="text-[12px] font-medium text-[#A1A1A6] mt-0.5">Total XP</span>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.3 }}
              className="p-6 rounded-[32px] bg-white border border-black/[0.03] shadow-[0_8px_40px_rgba(0,0,0,0.01)] col-span-2"
            >
              <div className="flex justify-between items-center">
                <div>
                  <span className="block text-[22px] font-bold text-[#1C1C1E]">{longestStreak} days</span>
                  <span className="text-[12px] font-medium text-[#A1A1A6] mt-0.5">Personal Record</span>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-20 text-[#1C1C1E]"><path d="m11 15 2 2 4-4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M7 2v4"/><path d="M17 2v4"/><path d="M3 10h18"/></svg>
              </div>
            </motion.div>
          </div>
        </div>
      </div>

      {/* SOCIAL SECTION */}
      <div className="relative z-10 px-8 mt-12 pb-8">
        <h3 className="text-[13px] font-bold text-[#A1A1A6] uppercase tracking-[0.1em] mb-6 px-1">Community</h3>
        <div className="flex gap-3">
          <button className="flex-1 py-4 px-6 rounded-3xl bg-[#1C1C1E] text-white text-[14px] font-semibold flex items-center justify-center gap-2 active:scale-95 transition-all shadow-lg hover:shadow-[#1C1C1E]/20">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
            Add Friends
          </button>
          <button 
            onClick={() => setShowQRCode(true)}
            className="w-14 h-14 rounded-3xl bg-white border border-black/5 flex items-center justify-center active:scale-95 transition-all shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60"><rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v.01"/></svg>
          </button>
        </div>
      </div>

      {/* ACCOUNT SECTION */}
      <div className="relative z-10 px-8 mt-12 mb-12 flex flex-col items-center">
        {(user && !user.isAnonymous && !connectSuccess) ? (
          <div className="flex flex-col items-center gap-1 opacity-40 hover:opacity-100 transition-opacity">
            <span className="text-[12px] font-medium text-[#1C1C1E]">{user.email?.replace(/(.{4})(.*)(?=@)/, "$1****")}</span>
            <span className="text-[10px] font-bold text-[#A1A1A6] uppercase tracking-widest">Signed in via Google</span>
            <button 
              onClick={handleLogout}
              className="mt-4 text-[12px] font-semibold text-red-500/60 hover:text-red-500 transition-colors uppercase tracking-widest"
            >
              Sign Out
            </button>
          </div>
        ) : (
          <button 
            onClick={handleLogin}
            disabled={isConnecting || connectSuccess}
            className={`w-full py-[16px] rounded-full border border-[#111111] ${connectSuccess ? 'bg-[#34C759] border-[#34C759]' : 'bg-[#111111]'} text-white text-[15px] font-semibold active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-[0_8px_16px_rgba(0,0,0,0.1)]`}
          >
            {isConnecting ? (
               <>
                 <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                 Connecting...
               </>
            ) : connectSuccess ? (
               "Account connected"
            ) : connectError ? (
               <span className="text-red-400">{connectError}</span>
            ) : (
               "Connect your account"
            )}
          </button>
        )}
      </div>

      {/* ROTATING TEXT (BOTTOM) */}
      <div className="relative z-10 mt-auto pt-12 pb-20 flex justify-center w-full px-8">
        <AnimatePresence mode="wait">
          <motion.p
            key={messageIndex}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="text-[17px] font-medium text-[#A1A1A6]/50 italic tracking-tight text-center"
          >
            {ROTATING_MESSAGES[messageIndex]}
          </motion.p>
        </AnimatePresence>
      </div>

      {/* SETTINGS OVERLAY */}
      <AnimatePresence>
        {showSettings && (
          <motion.div 
            initial={{ opacity: 0, y: "100%" }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[300] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            {/* SETTINGS HEADER */}
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl border-b border-white/5">
              <button 
                onClick={() => setShowSettings(false)}
                className="h-10 w-10 flex items-center justify-center rounded-full bg-white/10 active:scale-95 transition-all text-white outline-none"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Settings</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <SettingsGroup title="Account">
                <SettingsItem label="Profile" onClick={() => setShowProfileSubpage(true)} />
                <SettingsItem label="Save Progress" value={(user && !user.isAnonymous) ? "Connected" : "Not connected"} isLast />
              </SettingsGroup>

              <SettingsGroup title="Experience">
                <SettingsItem label="Notifications" value={expNotificationDaily || expNotificationStreak || expNotification1v1 || expNotificationSocial ? "On" : "Off"} onClick={() => setShowExpNotifications(true)} />
                <SettingsItem label="Sound & Haptics" value={expHapticsLevel} onClick={() => setShowExpHaptics(true)} />
                <SettingsItem label="Message Style" value={expMessageStyle} onClick={() => setShowExpMessageStyle(true)} isLast />
              </SettingsGroup>

              <SettingsGroup title="Social">
                <SettingsItem label="Friends" value="2 Online" onClick={() => setShowSocialFriends(true)} />
                <SettingsItem label="QR Sharing" onClick={() => setShowQRCode(true)} />
                <SettingsItem label="1v1 Challenges" value={social1v1Setting} onClick={() => setShowSocial1v1(true)} />
                <SettingsItem label="Ranking Visibility" value={socialRankingSetting} onClick={() => setShowSocialRanking(true)} />
                <SettingsItem label="Presence" value={socialPresenceSetting} onClick={() => setShowSocialPresence(true)} isLast />
              </SettingsGroup>

              <SettingsGroup title="Privacy">
                <SettingsItem label="Profile Visibility" value={privacyProfileVisibility} onClick={() => setShowPrivacyProfile(true)} />
                <SettingsItem label="Activity Visibility" value="Settings" onClick={() => setShowPrivacyActivity(true)} />
                <SettingsItem label="Online Status" value={privacyOnlineStatus ? "Visible" : "Hidden"} onClick={() => setShowPrivacyOnline(true)} />
                <SettingsItem label="Invisible Mode" value={privacyInvisibleMode ? "On" : "Off"} onClick={() => setShowPrivacyInvisible(true)} isLast />
              </SettingsGroup>

              <SettingsGroup title="Support">
                <SettingsItem label="Help Center" onClick={() => setShowSupportHelpCenter(true)} />
                <SettingsItem label="Send Feedback" onClick={() => setShowSupportFeedback(true)} />
                <SettingsItem label="Report Problem" onClick={() => setShowSupportReportProblem(true)} isLast />
              </SettingsGroup>

              <SettingsGroup title="Legal">
                <SettingsItem label="Terms of Service" value="Opens in browser" onClick={() => window.open('https://example.com/terms', '_blank')} />
                <SettingsItem label="Privacy Policy" value="Opens in browser" onClick={() => window.open('https://example.com/privacy', '_blank')} />
                <SettingsItem label="Community Rules" value="Opens in browser" onClick={() => window.open('https://example.com/rules', '_blank')} isLast />
              </SettingsGroup>

              {user && (
                <div className="mt-8 flex justify-center w-full">
                  <button 
                    onClick={() => {
                      handleLogout();
                      setShowSettings(false);
                    }}
                    className="py-4 px-8 rounded-full border border-red-500/20 text-red-400 text-[13px] font-bold uppercase tracking-[0.1em] active:scale-95 transition-all w-full flex items-center justify-center gap-2 hover:bg-red-500/10"
                  >
                    Log Out
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PROFILE SUBPAGE OVERLAY */}
      <AnimatePresence>
        {showProfileSubpage && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            {/* PROFILE HEADER borderless */}
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button 
                onClick={() => setShowProfileSubpage(false)}
                className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              
              {isEditingTitle ? (
                <input
                  autoFocus
                  value={tempTitle}
                  onChange={e => setTempTitle(e.target.value)}
                  onBlur={() => { setIsEditingTitle(false); triggerSave("Title"); }}
                  onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                  className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2 bg-transparent outline-none text-center w-[160px]"
                  maxLength={20}
                />
              ) : (
                <span 
                  onClick={() => setIsEditingTitle(true)}
                  className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2 cursor-pointer hover:opacity-80 transition-opacity"
                >
                  {tempTitle}
                </span>
              )}

              <button 
                onClick={() => setShowQRCode(true)}
                className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none hover:text-white"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/></svg>
              </button>
            </div>

            <div className="w-full px-6 pt-6 pb-32 flex flex-col max-w-[500px]">
              
              {/* Profile Area */}
              <div className="flex flex-col items-center mb-10 relative">
                 <input 
                   type="file" 
                   accept="image/*" 
                   ref={fileInputRef} 
                   onChange={handleAvatarChange} 
                   className="hidden" 
                 />
                 <button 
                   onClick={() => fileInputRef.current?.click()}
                   className="h-[104px] w-[104px] rounded-full border border-white/10 bg-[#1C1C1E] shadow-2xl overflow-hidden flex items-center justify-center relative mb-6 group active:scale-95 transition-all outline-none"
                 >
                  {(tempAvatar || user?.photoURL) ? (
                      <img src={(tempAvatar || user!.photoURL!) as string} alt="Avatar" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40 text-white"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  )}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white drop-shadow-md"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>
                  </div>
                 </button>
                 
                 {isEditingName ? (
                   <input
                     autoFocus
                     value={tempName}
                     onChange={e => setTempName(e.target.value)}
                     onBlur={() => { setIsEditingName(false); triggerSave("Name"); }}
                     onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                     className="text-[26px] font-semibold text-white tracking-tight text-center bg-transparent outline-none w-full mb-1"
                   />
                 ) : (
                   <div 
                     onClick={() => setIsEditingName(true)}
                     className="flex flex-col items-center group cursor-pointer active:scale-95 transition-all mb-1"
                   >
                     <h2 className="text-[26px] font-semibold text-white tracking-tight flex items-center justify-center">
                       {tempName}
                     </h2>
                   </div>
                 )}

                 {isEditingUsername ? (
                   <input
                     autoFocus
                     value={tempUsername}
                     onChange={e => setTempUsername(e.target.value)}
                     onBlur={() => { setIsEditingUsername(false); triggerSave("Username"); }}
                     onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                     className="text-[16px] font-medium text-white/50 tracking-wide text-center bg-transparent outline-none w-full"
                   />
                 ) : (
                   <span 
                     onClick={() => setIsEditingUsername(true)}
                     className="text-[16px] font-medium text-white/40 tracking-wide hover:text-white/60 transition-colors cursor-pointer"
                   >
                     {tempUsername}
                   </span>
                 )}
              </div>

              {/* Account Settings */}
              <div className="bg-[#1C1C1E]/50 rounded-[32px] overflow-hidden flex flex-col border border-white/[0.04]">
                {/* Email */}
                {isEditingEmail ? (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-6 py-5 flex flex-col gap-2 border-b border-white/[0.04] bg-white/[0.02]">
                    <span className="text-[12px] font-medium text-white/40 tracking-wide">Email</span>
                    <input
                     autoFocus
                     value={tempEmail}
                     onChange={e => setTempEmail(e.target.value)}
                     onBlur={() => { setIsEditingEmail(false); triggerSave("Email"); }}
                     onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                     className="text-[16px] font-medium text-white bg-transparent outline-none w-full"
                     placeholder="Enter email..."
                    />
                  </motion.div>
                ) : (
                  <button onClick={() => setIsEditingEmail(true)} className="w-full flex flex-col justify-center px-6 py-5 outline-none active:bg-white/[0.02] transition-colors text-left border-b border-white/[0.04]">
                    <span className="text-[12px] font-medium text-white/40 tracking-wide mb-1.5">Email</span>
                    <div className="flex items-center justify-between w-full">
                      <span className="text-[16px] font-medium text-white/90">{tempEmail || "Not set"}</span>
                      {user && !user.isAnonymous && <span className="text-[12px] font-medium text-[#5C5CFF] opacity-80">Connected with Google</span>}
                    </div>
                  </button>
                )}

                {/* Password */}
                {(!user || user.isAnonymous) ? null : (
                  isEditingPassword ? (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="px-6 py-5 flex flex-col gap-5 border-b border-white/[0.04] bg-white/[0.02]">
                      <div className="flex flex-col gap-2">
                        <span className="text-[12px] font-medium text-white/40 tracking-wide">Current Password</span>
                        <input
                          type="password"
                          value={tempPasswordCurrent}
                          onChange={e => setTempPasswordCurrent(e.target.value)}
                          className="text-[16px] font-medium text-white bg-white/[0.04] border border-white/5 rounded-xl px-4 py-3 outline-none w-full focus:border-white/20 transition-colors placeholder:text-white/20"
                          placeholder="••••••••"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <span className="text-[12px] font-medium text-white/40 tracking-wide">New Password</span>
                        <input
                          type="password"
                          value={tempPasswordNew}
                          onChange={e => setTempPasswordNew(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && (setIsEditingPassword(false), triggerSave("Password"))}
                          className="text-[16px] font-medium text-white bg-white/[0.04] border border-white/5 rounded-xl px-4 py-3 outline-none w-full focus:border-white/20 transition-colors placeholder:text-white/20"
                          placeholder="••••••••"
                        />
                      </div>
                      <button onClick={() => { setIsEditingPassword(false); triggerSave("Password"); }} className="mt-1 py-3 rounded-xl bg-white text-black text-[15px] font-semibold active:scale-95 transition-all shadow-[0_8px_16px_rgba(255,255,255,0.1)]">
                        Save Password
                      </button>
                    </motion.div>
                  ) : (
                    <button onClick={() => setIsEditingPassword(true)} className="w-full flex flex-col justify-center px-6 py-5 outline-none active:bg-white/[0.02] transition-colors text-left border-b border-white/[0.04]">
                      <span className="text-[12px] font-medium text-white/40 tracking-wide mb-1.5">Password</span>
                      <span className="text-[16px] font-medium text-white/90">••••••••</span>
                    </button>
                  )
                )}

                {/* Phone */}
                {isEditingPhone ? (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-6 py-5 flex flex-col gap-2 bg-white/[0.02]">
                    <span className="text-[12px] font-medium text-white/40 tracking-wide">Phone (optional)</span>
                    <input
                     autoFocus
                     value={tempPhone}
                     onChange={e => setTempPhone(e.target.value)}
                     onBlur={() => { setIsEditingPhone(false); triggerSave("Phone"); }}
                     onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                     className="text-[16px] font-medium text-white bg-transparent outline-none w-full"
                     placeholder="Enter phone number..."
                    />
                  </motion.div>
                ) : (
                  <button onClick={() => setIsEditingPhone(true)} className="w-full flex flex-col justify-center px-6 py-5 outline-none active:bg-white/[0.02] transition-colors text-left">
                    <span className="text-[12px] font-medium text-white/40 tracking-wide mb-1.5">Phone (optional)</span>
                    <span className="text-[16px] font-medium text-white/90">{tempPhone || "Not set"}</span>
                  </button>
                )}
              </div>

              {/* Danger Zone */}
              <div className="mt-12 flex flex-col gap-4 items-center justify-center w-full px-2">
                <button 
                  onClick={() => {
                    handleLogout();
                    setShowProfileSubpage(false);
                    setShowSettings(false);
                  }}
                  className="py-4 rounded-full bg-[#1C1C1E] text-white/80 text-[15px] font-medium active:scale-95 transition-all w-full flex items-center justify-center shadow-sm outline-none"
                >
                  Log Out
                </button>
                
                <button 
                  onClick={() => setShowDeleteConfirm(true)}
                  className="py-4 rounded-full border border-red-500/20 text-red-400 text-[15px] font-medium active:scale-[0.98] transition-all w-full flex items-center justify-center hover:bg-red-500/5 outline-none"
                >
                  Delete Account
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* EXPERIENCE SUBPAGES OVERLAYS */}
      <AnimatePresence>
        {showExpNotifications && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowExpNotifications(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Notifications</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="mb-10 text-center">
                 <p className="text-[14px] text-white/50 leading-relaxed max-w-[280px] mx-auto font-medium">
                   Smart timing is active. The system learns your routine and avoids unneeded interruptions.
                 </p>
              </div>

              <div className="flex flex-col rounded-[24px] bg-white/[0.02] border border-white/[0.04] overflow-hidden p-2 gap-1 mb-8">
                {[
                  { label: "Daily Reminders", value: expNotificationDaily, setFn: setExpNotificationDaily },
                  { label: "Streak Alerts", value: expNotificationStreak, setFn: setExpNotificationStreak },
                  { label: "1v1 Challenges", value: expNotification1v1, setFn: setExpNotification1v1 },
                  { label: "Social Activity", value: expNotificationSocial, setFn: setExpNotificationSocial },
                ].map((item, idx) => (
                  <button 
                    key={idx}
                    onClick={() => item.setFn(!item.value)}
                    className="flex items-center justify-between px-4 py-4 rounded-xl active:bg-white/[0.04] transition-colors outline-none w-full text-left"
                  >
                    <span className="text-[16px] font-medium tracking-tight text-white/90">{item.label}</span>
                    <div className={`w-[46px] h-[28px] rounded-full flex items-center p-[2px] transition-colors duration-300 ${item.value ? 'bg-[#FF9F0A]' : 'bg-white/10'}`}>
                      <motion.div 
                        initial={false}
                        animate={{ x: item.value ? 18 : 0 }}
                        className="w-[24px] h-[24px] bg-white rounded-full shadow-sm"
                      />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {showExpHaptics && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowExpHaptics(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Sound & Haptics</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="mb-10 text-center">
                 <p className="text-[14px] text-white/50 leading-relaxed max-w-[280px] mx-auto font-medium">
                   Premium physical feedback for important actions.
                 </p>
              </div>

              <div className="flex flex-col gap-2">
                {[
                  { id: "Off", label: "Off" },
                  { id: "Subtle", label: "Subtle", desc: "Clean, minimal feedback." },
                  { id: "Strong", label: "Strong", desc: "For full competitive immersion." },
                ].map((item) => (
                  <button 
                    key={item.id}
                    onClick={() => {
                      setExpHapticsLevel(item.id as any);
                      // In a real app we'd trigger a haptic pulse here
                      if (navigator.vibrate && item.id !== "Off") {
                        navigator.vibrate(item.id === "Strong" ? 40 : 15);
                      }
                    }}
                    className={`flex items-center justify-between px-6 py-5 rounded-[20px] transition-all outline-none border ${expHapticsLevel === item.id ? 'bg-white/[0.06] border-white/10' : 'bg-transparent border-transparent hover:bg-white/[0.02]'}`}
                  >
                    <div className="flex flex-col items-start gap-1">
                      <span className={`text-[16px] font-semibold tracking-tight ${expHapticsLevel === item.id ? 'text-white' : 'text-white/60'}`}>{item.label}</span>
                      {item.desc && <span className="text-[13px] font-medium text-white/30">{item.desc}</span>}
                    </div>
                    {expHapticsLevel === item.id && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A]"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {showExpMessageStyle && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowExpMessageStyle(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Message Style</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-6 pb-32 flex flex-col gap-4 max-w-[500px]">
              {[
                { 
                  id: "Minimal", 
                  title: "Minimal", 
                  desc: "Softer tone. Clean and simple messaging.",
                  preview: "keep going."
                },
                { 
                  id: "Balanced", 
                  title: "Balanced", 
                  desc: "The default Level Up tone. Emotionally controlled.",
                  preview: "still locked in?"
                },
                { 
                  id: "Provocative", 
                  title: "Provocative", 
                  desc: "Intense social pressure.",
                  preview: "too slow."
                },
              ].map((style) => (
                <button 
                  key={style.id}
                  onClick={() => setExpMessageStyle(style.id as any)}
                  className={`flex flex-col p-6 rounded-[24px] outline-none transition-all active:scale-[0.98] border bg-[#1C1C1E]/40 ${expMessageStyle === style.id ? 'border-[#FF9F0A]/40 shadow-[0_0_20px_rgba(255,159,10,0.1)]' : 'border-white/5 hover:border-white/10'}`}
                >
                  <div className="flex items-center justify-between w-full mb-6">
                    <span className={`text-[18px] font-semibold tracking-tight ${expMessageStyle === style.id ? 'text-white' : 'text-white/60'}`}>{style.title}</span>
                    <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${expMessageStyle === style.id ? 'border-[#FF9F0A]' : 'border-white/20'}`}>
                       {expMessageStyle === style.id && <div className="w-3 h-3 rounded-full bg-[#FF9F0A]" />}
                    </div>
                  </div>
                  <div className="w-full py-6 rounded-2xl bg-[#111111]/80 border border-white/5 flex items-center justify-center mb-4">
                    <span className={`text-[15px] font-medium italic ${expMessageStyle === style.id ? 'text-white' : 'text-white/40'}`}>
                      "{style.preview}"
                    </span>
                  </div>
                  <span className="text-[13px] font-medium text-white/40 text-left leading-relaxed w-[90%]">
                    {style.desc}
                  </span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SOCIAL SUBPAGES OVERLAYS */}
      <AnimatePresence>
        {showSocialFriends && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowSocialFriends(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Friends</span>
              <div className="w-10 h-10 flex items-center justify-center">
                 <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              </div>
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col gap-6 max-w-[500px]">
              {/* Add Friend Button */}
              <button className="flex items-center gap-3 p-4 rounded-[20px] bg-white/[0.04] border border-white/5 active:scale-[0.98] transition-all outline-none">
                <div className="w-12 h-12 rounded-full bg-[#FF9F0A]/20 flex items-center justify-center text-[#FF9F0A]">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
                </div>
                <div className="flex flex-col items-start">
                  <span className="text-[16px] font-semibold text-white">Add Friend</span>
                  <span className="text-[13px] font-medium text-white/50">via username or QR</span>
                </div>
              </button>

              <div className="flex flex-col gap-1 mt-4">
                 <span className="text-[11px] font-bold text-white/30 uppercase tracking-[0.1em] px-2 mb-2">Pending Requests (1)</span>
                 <div className="flex items-center justify-between p-4 rounded-[20px] bg-white/[0.02] border border-white/5">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white/50 font-medium">M</div>
                      <div className="flex flex-col">
                        <span className="text-[15px] font-semibold text-white">Marcus</span>
                        <span className="text-[12px] font-medium text-white/40">wants to challenge</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                       <button className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/60 active:scale-95 transition-all"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
                       <button className="w-8 h-8 rounded-full bg-[#FF9F0A] flex items-center justify-center text-white active:scale-95 transition-all"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
                    </div>
                 </div>
              </div>

              <div className="flex flex-col gap-1 mt-4">
                 <span className="text-[11px] font-bold text-white/30 uppercase tracking-[0.1em] px-2 mb-2">Online</span>
                 <div className="flex items-center justify-between p-4 rounded-[20px] bg-transparent hover:bg-white/[0.02] transition-colors cursor-pointer active:scale-[0.99] outline-none">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center font-medium">A</div>
                        <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-[#111111] bg-[#34C759]" />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[15px] font-semibold text-white">Alex</span>
                        <span className="text-[12px] font-medium text-white/40">12 day streak • 1400 XP</span>
                      </div>
                    </div>
                    <button className="text-[13px] font-semibold text-[#FF9F0A] px-3 py-1.5 rounded-full bg-[#FF9F0A]/10 active:scale-95 transition-all outline-none">
                      Challenge
                    </button>
                 </div>
                 <div className="flex items-center justify-between p-4 rounded-[20px] bg-transparent hover:bg-white/[0.02] transition-colors cursor-pointer active:scale-[0.99] outline-none">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-medium">S</div>
                        <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-[#111111] bg-[#FF9F0A]" />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[15px] font-semibold text-white">Sarah</span>
                        <span className="text-[12px] font-medium text-[#FF9F0A]">in challenge</span>
                      </div>
                    </div>
                 </div>
              </div>
            </div>
          </motion.div>
        )}

        {showSocial1v1 && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowSocial1v1(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">1v1 Challenges</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="mb-10 text-center">
                 <p className="text-[14px] text-white/50 leading-relaxed max-w-[280px] mx-auto font-medium">
                   Control who can send you challenge requests. Cooldowns are enforced automatically.
                 </p>
              </div>

              <div className="flex flex-col gap-2">
                {[
                  { id: "Everyone", label: "Everyone", desc: "Anyone can send a challenge." },
                  { id: "Friends Only", label: "Friends Only", desc: "Only accepted friends can challenge." },
                  { id: "No One", label: "No One", desc: "Block all incoming challenge requests." },
                ].map((item) => (
                  <button 
                    key={item.id}
                    onClick={() => setSocial1v1Setting(item.id as any)}
                    className={`flex items-center justify-between px-6 py-5 rounded-[20px] transition-all outline-none border ${social1v1Setting === item.id ? 'bg-white/[0.06] border-white/10' : 'bg-transparent border-transparent hover:bg-white/[0.02]'}`}
                  >
                    <div className="flex flex-col items-start gap-1">
                      <span className={`text-[16px] font-semibold tracking-tight ${social1v1Setting === item.id ? 'text-white' : 'text-white/60'}`}>{item.label}</span>
                      <span className="text-[13px] font-medium text-white/30">{item.desc}</span>
                    </div>
                    {social1v1Setting === item.id && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A]"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {showSocialRanking && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowSocialRanking(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Ranking Visibility</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="mb-10 text-center">
                 <p className="text-[14px] text-white/50 leading-relaxed max-w-[280px] mx-auto font-medium">
                   Choose how your progress appears on competitive leaderboards.
                 </p>
              </div>

              <div className="flex flex-col gap-2">
                {[
                  { id: "Public", label: "Public", desc: "Visible to everyone in global rankings." },
                  { id: "Friends Only", label: "Friends Only", desc: "Only visible on friends leaderboard." },
                  { id: "Private", label: "Private", desc: "Ghost mode. You do not appear on rankings." },
                ].map((item) => (
                  <button 
                    key={item.id}
                    onClick={() => setSocialRankingSetting(item.id as any)}
                    className={`flex items-center justify-between px-6 py-5 rounded-[20px] transition-all outline-none border ${socialRankingSetting === item.id ? 'bg-white/[0.06] border-white/10' : 'bg-transparent border-transparent hover:bg-white/[0.02]'}`}
                  >
                    <div className="flex flex-col items-start gap-1">
                      <span className={`text-[16px] font-semibold tracking-tight ${socialRankingSetting === item.id ? 'text-white' : 'text-white/60'}`}>{item.label}</span>
                      <span className="text-[13px] font-medium text-white/30">{item.desc}</span>
                    </div>
                    {socialRankingSetting === item.id && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A]"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {showSocialPresence && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowSocialPresence(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Presence</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="mb-10 text-center">
                 <p className="text-[14px] text-white/50 leading-relaxed max-w-[280px] mx-auto font-medium">
                   This status is visible to your accepted friends.
                 </p>
              </div>

              <div className="flex flex-col gap-2">
                {[
                  { id: "Online", label: "Online", icon: <div className="w-3 h-3 rounded-full bg-[#34C759]" /> },
                  { id: "Active Now", label: "Active Now", icon: <div className="w-3 h-3 rounded-full bg-[#34C759] shadow-[0_0_8px_rgba(52,199,89,0.6)]" /> },
                  { id: "In Challenge", label: "In Challenge", icon: <div className="w-3 h-3 rounded-full bg-[#FF9F0A] shadow-[0_0_8px_rgba(255,159,10,0.6)]" /> },
                  { id: "Waiting", label: "Waiting", icon: <div className="w-3 h-3 rounded-full border-2 border-white/40" /> },
                  { id: "Offline", label: "Appear Offline", icon: <div className="w-3 h-3 rounded-full bg-white/10" /> },
                ].map((item) => (
                  <button 
                    key={item.id}
                    onClick={() => setSocialPresenceSetting(item.id as any)}
                    className={`flex items-center justify-between px-6 py-5 rounded-[20px] transition-all outline-none border ${socialPresenceSetting === item.id ? 'bg-white/[0.06] border-white/10' : 'bg-transparent border-transparent hover:bg-white/[0.02]'}`}
                  >
                    <div className="flex items-center gap-4">
                      {item.icon}
                      <span className={`text-[16px] font-semibold tracking-tight ${socialPresenceSetting === item.id ? 'text-white' : 'text-white/60'}`}>{item.label}</span>
                    </div>
                    {socialPresenceSetting === item.id && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A]"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PRIVACY SUBPAGES OVERLAYS */}
      <AnimatePresence>
        {showPrivacyProfile && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowPrivacyProfile(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Profile Visibility</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="flex flex-col gap-2">
                {[
                  { id: "Public", label: "Public", desc: "Everyone can see your profile." },
                  { id: "Friends", label: "Friends", desc: "Only approved friends." },
                  { id: "Private", label: "Private", desc: "Your profile becomes limited." },
                ].map((item) => (
                  <button 
                    key={item.id}
                    onClick={() => {
                      if (item.id === "Private" && privacyProfileVisibility !== "Private") {
                        setPrivacyConfirmModal({
                          show: true,
                          title: "Make Profile Private?",
                          description: "Your profile visibility will change. Only you will see your full progress.",
                          onConfirm: () => {
                            setPrivacyProfileVisibility("Private");
                            setPrivacyConfirmModal(prev => ({ ...prev, show: false }));
                          }
                        });
                      } else {
                        setPrivacyProfileVisibility(item.id as any);
                      }
                    }}
                    className={`flex items-center justify-between px-6 py-5 rounded-[20px] transition-all outline-none border ${privacyProfileVisibility === item.id ? 'bg-white/[0.06] border-white/10' : 'bg-transparent border-transparent hover:bg-white/[0.02]'}`}
                  >
                    <div className="flex flex-col items-start gap-1">
                      <span className={`text-[16px] font-semibold tracking-tight ${privacyProfileVisibility === item.id ? 'text-white' : 'text-white/60'}`}>{item.label}</span>
                      <span className="text-[13px] font-medium text-white/30">{item.desc}</span>
                    </div>
                    {privacyProfileVisibility === item.id && (
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF9F0A]"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {showPrivacyActivity && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowPrivacyActivity(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Activity Visibility</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="flex flex-col rounded-[24px] bg-white/[0.02] border border-white/[0.04] overflow-hidden p-2 gap-1 mb-8">
                {[
                  { label: "Streak", desc: "Show your streak to others.", value: privacyActivityStreak, setFn: setPrivacyActivityStreak },
                  { label: "Ranking", desc: "Appear in rankings.", value: privacyActivityRanking, setFn: setPrivacyActivityRanking },
                  { label: "Activity", desc: "Show recent activity.", value: privacyActivityRecent, setFn: setPrivacyActivityRecent },
                  { label: "Challenge History", desc: "Show past 1v1 outcomes.", value: privacyActivityChallenges, setFn: setPrivacyActivityChallenges },
                ].map((item, idx) => (
                  <button 
                    key={idx}
                    onClick={() => {
                      if (item.value) {
                         setPrivacyConfirmModal({
                           show: true,
                           title: `Hide ${item.label}?`,
                           description: `Others will no longer see your ${item.label.toLowerCase()}.`,
                           onConfirm: () => {
                             item.setFn(false);
                             setPrivacyConfirmModal(prev => ({ ...prev, show: false }));
                           }
                         });
                      } else {
                         item.setFn(true);
                      }
                    }}
                    className="flex items-center justify-between px-4 py-4 rounded-xl active:bg-white/[0.04] transition-colors outline-none w-full text-left"
                  >
                    <div className="flex flex-col">
                      <span className="text-[16px] font-medium tracking-tight text-white/90">{item.label}</span>
                      <span className="text-[13px] text-white/40">{item.desc}</span>
                    </div>
                    <div className={`w-[46px] h-[28px] rounded-full flex items-center p-[2px] transition-colors duration-300 ${item.value ? 'bg-[#FF9F0A]' : 'bg-white/10'}`}>
                      <motion.div 
                        initial={false}
                        animate={{ x: item.value ? 18 : 0 }}
                        className="w-[24px] h-[24px] bg-white rounded-full shadow-sm"
                      />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {showPrivacyOnline && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowPrivacyOnline(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Online Status</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="flex flex-col rounded-[24px] bg-white/[0.02] border border-white/[0.04] overflow-hidden p-2">
                <button 
                  onClick={() => {
                    if (privacyOnlineStatus) {
                      setPrivacyConfirmModal({
                        show: true,
                        title: "Hide Online Status?",
                        description: "You will appear offline to everyone.",
                        onConfirm: () => {
                          setPrivacyOnlineStatus(false);
                          setPrivacyConfirmModal(prev => ({ ...prev, show: false }));
                        }
                      });
                    } else {
                      setPrivacyOnlineStatus(true);
                    }
                  }}
                  className="flex items-center justify-between px-4 py-4 rounded-xl active:bg-white/[0.04] transition-colors outline-none w-full text-left"
                >
                  <div className="flex flex-col">
                    <span className="text-[16px] font-medium tracking-tight text-white/90">Show Online Status</span>
                    <span className="text-[13px] text-white/40">Hide your live presence.</span>
                  </div>
                  <div className={`w-[46px] h-[28px] rounded-full flex items-center p-[2px] transition-colors duration-300 ${privacyOnlineStatus ? 'bg-[#FF9F0A]' : 'bg-white/10'}`}>
                    <motion.div 
                      initial={false}
                      animate={{ x: privacyOnlineStatus ? 18 : 0 }}
                      className="w-[24px] h-[24px] bg-white rounded-full shadow-sm"
                    />
                  </div>
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {showPrivacyInvisible && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowPrivacyInvisible(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Invisible Mode</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="flex flex-col rounded-[24px] bg-white/[0.02] border border-white/[0.04] overflow-hidden p-2 gap-1 mb-8">
                <button 
                  onClick={() => {
                     if (!privacyInvisibleMode) {
                       setPrivacyConfirmModal({
                         show: true,
                         title: "Go Invisible?",
                         description: "Disappear from social visibility. You can continue using the app normally.",
                         onConfirm: () => {
                           setPrivacyInvisibleMode(true);
                           setPrivacyConfirmModal(prev => ({ ...prev, show: false }));
                         }
                       });
                     } else {
                       setPrivacyInvisibleMode(false);
                     }
                  }}
                  className="flex items-center justify-between px-4 py-4 rounded-xl active:bg-white/[0.04] transition-colors outline-none w-full text-left"
                >
                  <div className="flex flex-col">
                    <span className="text-[16px] font-medium tracking-tight text-white/90">Invisible Mode</span>
                    <span className="text-[13px] text-white/40">Disappear from social visibility.</span>
                  </div>
                  <div className={`w-[46px] h-[28px] rounded-full flex items-center p-[2px] transition-colors duration-300 ${privacyInvisibleMode ? 'bg-[#FF9F0A]' : 'bg-white/10'}`}>
                    <motion.div 
                      initial={false}
                      animate={{ x: privacyInvisibleMode ? 18 : 0 }}
                      className="w-[24px] h-[24px] bg-white rounded-full shadow-sm"
                    />
                  </div>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PRIVACY CONFIRMATION MODAL */}
      <AnimatePresence>
        {privacyConfirmModal.show && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[600] flex items-center justify-center bg-black/60 backdrop-blur-md px-6"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 10 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="bg-[#1C1C1E] rounded-[28px] p-6 w-full max-w-[320px] flex flex-col items-center border border-white/10 shadow-2xl"
            >
              <h3 className="text-[18px] font-semibold text-white tracking-tight text-center mb-2">{privacyConfirmModal.title}</h3>
              <p className="text-[14px] text-white/60 text-center mb-8 px-2 leading-relaxed">{privacyConfirmModal.description}</p>
              
              <div className="flex flex-col gap-3 w-full">
                <button
                  onClick={privacyConfirmModal.onConfirm}
                  className="w-full py-3.5 rounded-2xl bg-white/10 hover:bg-white/15 text-white font-semibold text-[15px] tracking-tight transition-colors outline-none"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setPrivacyConfirmModal(prev => ({ ...prev, show: false }))}
                  className="w-full py-3.5 rounded-2xl bg-transparent hover:bg-white/5 text-white/50 font-medium text-[15px] tracking-tight transition-colors outline-none"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SUPPORT SUBPAGES OVERLAYS */}
      <AnimatePresence>
        {showSupportHelpCenter && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button onClick={() => setShowSupportHelpCenter(false)} className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Help Center</span>
              <div className="w-10 h-10" />
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="mb-10 text-center">
                 <p className="text-[14px] text-white/50 leading-relaxed max-w-[280px] mx-auto font-medium">
                   Need help? Find quick answers here.
                 </p>
              </div>

              <div className="flex flex-col gap-2">
                {[
                  { id: "streaks", title: "How do streaks work?", content: "Complete missions daily to keep your momentum alive. Miss a day, reset to zero." },
                  { id: "challenges", title: "1v1 Challenges", content: "Challenge friends from their profile or scan their QR code to compete directly." },
                  { id: "qr", title: "QR Sharing", content: "A fast way to connect. Just pull down your profile to reveal your code." },
                  { id: "rankings", title: "Rankings & XP", content: "XP determines your global rank. Play consistently to climb." },
                  { id: "account", title: "Account & Login", content: "Your progress is tied to your Google account. Connect it to never lose data." },
                ].map((topic) => (
                  <button 
                    key={topic.id}
                    onClick={() => setExpandedHelpTopic(expandedHelpTopic === topic.id ? null : topic.id)}
                    className="flex flex-col px-6 py-5 rounded-[20px] bg-white/[0.02] border border-white/[0.04] transition-all outline-none"
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="text-[16px] font-semibold tracking-tight text-white/90">{topic.title}</span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-white/40 transition-transform ${expandedHelpTopic === topic.id ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6"/></svg>
                    </div>
                    <AnimatePresence>
                      {expandedHelpTopic === topic.id && (
                        <motion.div
                          initial={{ height: 0, opacity: 0, marginTop: 0 }}
                          animate={{ height: "auto", opacity: 1, marginTop: 12 }}
                          exit={{ height: 0, opacity: 0, marginTop: 0 }}
                          className="overflow-hidden"
                        >
                          <p className="text-[14px] text-white/50 text-left leading-relaxed">{topic.content}</p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {showSupportFeedback && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button 
                onClick={() => setShowSupportFeedback(false)} 
                className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Send Feedback</span>
              <button 
                onClick={() => {
                  if (feedbackText.trim()) {
                    setFeedbackText("");
                    setShowSupportFeedback(false);
                    setSupportSubmitState({ show: true, msg: "Thank you. We're listening." });
                    setTimeout(() => setSupportSubmitState({ show: false, msg: "" }), 3000);
                  }
                }}
                className={`text-[15px] font-bold tracking-tight outline-none ${feedbackText.trim() ? 'text-[#FF9F0A]' : 'text-white/20'}`}
              >
                Send
              </button>
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="mb-8">
                 <h2 className="text-[28px] font-semibold text-white tracking-tight mb-2">What's on your mind?</h2>
                 <p className="text-[15px] text-white/50 leading-relaxed max-w-[280px]">
                   Tell us what could improve. We're listening.
                 </p>
              </div>

              <textarea 
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Your suggestions or thoughts..."
                className="w-full h-[200px] bg-white/[0.04] border border-white/5 rounded-[24px] p-5 text-[16px] text-white placeholder:text-white/30 resize-none outline-none focus:border-[#FF9F0A]/30 transition-colors"
                autoFocus
              />
            </div>
          </motion.div>
        )}

        {showSupportReportProblem && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed inset-0 z-[400] bg-[#111111] flex flex-col items-center overflow-y-auto"
          >
            <div className="sticky top-0 w-full z-10 flex items-center justify-between px-6 pt-16 pb-4 bg-[#111111]/80 backdrop-blur-xl">
              <button 
                onClick={() => setShowSupportReportProblem(false)} 
                className="h-10 w-10 flex items-center justify-center rounded-full active:scale-95 transition-all text-white/60 outline-none"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-[17px] font-semibold tracking-tight text-white absolute left-1/2 -translate-x-1/2">Report Problem</span>
              <button 
                onClick={() => {
                  if (reportText.trim()) {
                    setReportText("");
                    setShowSupportReportProblem(false);
                    setSupportSubmitState({ show: true, msg: "Report sent. We'll take a look." });
                    setTimeout(() => setSupportSubmitState({ show: false, msg: "" }), 3000);
                  }
                }}
                className={`text-[15px] font-bold tracking-tight outline-none ${reportText.trim() ? 'text-[#FF9F0A]' : 'text-white/20'}`}
              >
                Submit
              </button>
            </div>

            <div className="w-full px-6 pt-8 pb-32 flex flex-col max-w-[500px]">
              <div className="mb-8">
                 <h2 className="text-[28px] font-semibold text-white tracking-tight mb-2">Describe the issue.</h2>
                 <p className="text-[15px] text-white/50 leading-relaxed max-w-[280px]">
                   A bug, a visual issue, or a broken feature? We'll fix it.
                 </p>
              </div>

              <textarea 
                value={reportText}
                onChange={(e) => setReportText(e.target.value)}
                placeholder="What exactly went wrong..."
                className="w-full h-[200px] bg-white/[0.04] border border-white/5 rounded-[24px] p-5 text-[16px] text-white placeholder:text-white/30 resize-none outline-none focus:border-red-500/30 transition-colors"
                autoFocus
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SUPPORT STATUS/TOAST MODAL */}
      <AnimatePresence>
        {supportSubmitState.show && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-12 left-0 right-0 z-[600] flex justify-center pointer-events-none px-6"
          >
            <div className="bg-[#1C1C1E] border border-white/10 shadow-2xl rounded-full px-6 py-4 flex items-center justify-center">
              <span className="text-[14px] font-medium text-white tracking-tight">{supportSubmitState.msg}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* QR CODE OVERLAY */}
      <AnimatePresence>
        {showQRCode && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[500] bg-[#FDFDFB]/95 backdrop-blur-sm flex flex-col items-center justify-center p-6"
          >
            <div className="absolute top-16 right-8">
              <button 
                onClick={() => setShowQRCode(false)}
                className="h-10 w-10 flex items-center justify-center rounded-full bg-black/5 active:scale-95 transition-all outline-none"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>

            <motion.div 
              initial={{ scale: 0.95, y: 15, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 15, opacity: 0 }}
              transition={{ type: "spring", stiffness: 350, damping: 30 }}
              className="bg-white p-8 pb-8 rounded-[40px] shadow-[0_24px_80px_-12px_rgba(0,0,0,0.06)] border border-black/[0.03] flex flex-col items-center w-full max-w-[320px]"
            >
              <h4 className="text-[20px] font-medium text-[#1C1C1E] tracking-tight mb-8">
                {user?.displayName || "Player"}
              </h4>

              <div className="relative flex items-center justify-center rounded-[24px] overflow-hidden p-2 bg-white">
                <QRCodeSVG
                  value={user?.uid ? `https://levelup.app/u/${user.uid}` : "https://levelup.app"}
                  size={180}
                  bgColor={"#ffffff"}
                  fgColor={"#1C1C1E"}
                  level={"H"}
                  includeMargin={false}
                  imageSettings={user?.photoURL ? {
                    src: user.photoURL,
                    x: undefined,
                    y: undefined,
                    height: 48,
                    width: 48,
                    excavate: true,
                  } : undefined}
                />
                {!user?.photoURL && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-12 h-12 bg-white rounded-full border-2 border-white flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#1C1C1E]"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    </div>
                  </div>
                )}
              </div>

              <span className="text-[12px] font-semibold text-[#A1A1A6] tracking-[0.25em] uppercase mt-10 mb-8 opacity-60">
                Level Up
              </span>

              <div className="flex gap-3 w-full">
                <button 
                  onClick={handleSendLink}
                  className="flex-[3] py-3.5 rounded-full bg-[#1C1C1E] text-white text-[14px] font-medium active:scale-95 transition-all shadow-[0_8px_16px_rgba(28,28,30,0.1)] outline-none"
                >
                  Send Link
                </button>
                <button 
                  onClick={handleCopyLink}
                  className="flex-[2] py-3.5 rounded-full bg-black/5 text-[#1C1C1E] text-[14px] font-medium active:scale-95 transition-all hover:bg-black/10 outline-none flex items-center justify-center"
                >
                  {copied ? (
                    <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="flex items-center gap-1">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-[#5C5CFF]"><polyline points="20 6 9 17 4 12"/></svg>
                      Copied
                    </motion.div>
                  ) : (
                    "Copy Link"
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* DELETE CONFIRM OVERLAY */}
      <AnimatePresence>
        {showDeleteConfirm && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[600] bg-[#111111]/80 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 10, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 10, opacity: 0 }}
              className="bg-[#1C1C1E] p-8 rounded-[32px] shadow-2xl border border-white/10 flex flex-col items-center max-w-[320px] w-full"
            >
              <h3 className="text-[20px] font-semibold text-white mb-2 tracking-tight">Delete Account</h3>
              <p className="text-[15px] text-white/50 text-center mb-8">This action cannot be undone.</p>
              <div className="flex items-center gap-3 w-full">
                <button 
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 py-3.5 rounded-full bg-white/10 text-white font-medium active:scale-95 transition-all outline-none"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    setShowDeleteConfirm(false);
                  }}
                  className="flex-1 py-3.5 rounded-full bg-red-500 text-white font-medium active:scale-95 transition-all outline-none"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SAVED TOAST */}
      <AnimatePresence>
        {showSavedToast && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="absolute bottom-10 left-1/2 -translate-x-1/2 z-[600] bg-white text-black px-5 py-3 rounded-full shadow-2xl font-semibold tracking-wide flex items-center gap-2 text-[14px]"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-80"><path d="M20 6 9 17l-5-5"/></svg>
            Saved {showSavedToast}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function getInitialProgress() {
  const saved = localStorage.getItem('levelup_data');
  if (saved) {
    try {
      const data = JSON.parse(saved);
      const today = new Date().toLocaleDateString('en-CA');
      let streak = data.streak || 0;
      let longestStreak = data.longestStreak || 0;
      let hasCompletedToday = data.hasCompletedToday || false;
      
      if (data.lastCompletedDate) {
        const last = new Date(data.lastCompletedDate);
        const curr = new Date(today);
        const diffMS = curr.getTime() - last.getTime();
        const diffDays = Math.round(diffMS / (1000 * 3600 * 24));
        if (diffDays === 1) {
          hasCompletedToday = false;
        } else if (diffDays > 1) {
          hasCompletedToday = false;
          streak = 0;
        }
      }
      return { ...data, streak, longestStreak, hasCompletedToday };
    } catch(e) {}
  }
  return null;
}

export default function App() {
  const [appState, setAppState] = useState<'onboarding_1' | 'onboarding_2' | 'home' | 'mission' | 'reward' | 'challenge' | 'invite' | 'profile' | 'match_1v1' | 'match_result' | 'streak_detail'>('onboarding_1');
  const [missionIndex, setMissionIndex] = useState(0);
  const [completedMissionsCount, setCompletedMissionsCount] = useState(0);
  const [totalXP, setTotalXP] = useState(0);
  const [lastEarnedXP, setLastEarnedXP] = useState(0);
  const [streak, setStreak] = useState(0);
  const [longestStreak, setLongestStreak] = useState(0);
  const [hasCompletedToday, setHasCompletedToday] = useState(false);
  const [lastCompletedDate, setLastCompletedDate] = useState("");
  const [justIncreasedStreak, setJustIncreasedStreak] = useState(false);
  const [shouldCelebratePerfectWeek, setShouldCelebratePerfectWeek] = useState(false);
  const streakSessionRef = useRef<StreakSession | null>(null);
  const todayUtcRef = useRef(getTodayUtcKey());
  const pendingCompletionRef = useRef<MissionCompletionRecord | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [opponentName, setOpponentName] = useState("Alex");
  const [matchScores, setMatchScores] = useState({ user: 0, opponent: 0 });
  const [user, setUser] = useState<User | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const [showLoginSuggestion, setShowLoginSuggestion] = useState(false);
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [returnMsg, setReturnMsg] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (u) {
        setUser(u);
      } else {
        // If user logs out or is null, create a new anonymous session instantly
        import('firebase/auth').then(({ signInAnonymously }) => {
          signInAnonymously(auth).then((cred) => {
            setUser(cred.user);
          }).catch((err) => {
             console.error("Failed to re-authenticate anonymously:", err);
          });
        });
      }
    });

    return () => unsubscribe();
  }, []);

  const triggerReturnFeedback = () => {
    const msgs = ["nice", "good reset", "you're back", "take a break"];
    setReturnMsg(msgs[Math.floor(Math.random() * msgs.length)]);
    setTimeout(() => setReturnMsg(""), 2500);
  };

  const applyStreakSession = (
    session: StreakSession,
    options?: { preserveCelebration?: boolean },
  ) => {
    streakSessionRef.current = session;
    todayUtcRef.current = session.todayUtc;
    setStreak(session.state.streak);
    setLongestStreak(session.state.longestStreak);
    setHasCompletedToday(session.state.hasCompletedToday);
    setLastCompletedDate(session.state.lastCompletedDate);
    if (session.state.shouldCelebratePerfectWeek) {
      setShouldCelebratePerfectWeek(true);
      window.setTimeout(() => setShouldCelebratePerfectWeek(false), 3500);
    } else if (!options?.preserveCelebration) {
      setShouldCelebratePerfectWeek(false);
    }
    mergeStreakIntoStorage(session.state, session.history);
    setHistoryVersion((v) => v + 1);
  };

  useEffect(() => {
    const tick = () => {
      const todayUtc = getTodayUtcKey();
      if (todayUtc === todayUtcRef.current) return;
      todayUtcRef.current = todayUtc;
      const base = streakSessionRef.current ?? syncStreakFromRemote(null, todayUtc);
      applyStreakSession(reconcileStreakSession(base, todayUtc));
    };

    const interval = window.setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    
    // Realtime offline-first sync
    const unsubscribe = onSnapshot(doc(db, 'users', user.uid), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const session = syncStreakFromRemote(data, getTodayUtcKey());
        applyStreakSession(session, { preserveCelebration: true });
        
        setMissionIndex(data.currentMission || 0);
        setCompletedMissionsCount(data.missionsCompleted || 0);
        setTotalXP(data.xp || 0);
        if (data.appState && !isDataLoaded) setAppState(data.appState);
      }
      setIsDataLoaded(true);
    }, (error) => {
      console.error("Firestore sync error:", error);
    });

    return () => unsubscribe();
  }, [user, isDataLoaded]);

  useEffect(() => {
    if (user && isDataLoaded) {
      const syncToCloud = async () => {
        try {
          const pending = pendingCompletionRef.current;
          const data: Record<string, unknown> = {
            currentMission: missionIndex,
            missionsCompleted: completedMissionsCount,
            xp: totalXP,
            level: Math.floor(totalXP / 100) || 1,
            streak,
            longestStreak,
            hasCompletedToday,
            lastCompletedDate,
            lastStreakUpdateDayKeyUTC:
              streakSessionRef.current?.state.lastStreakUpdateDayKeyUTC ?? getTodayUtcKey(),
            appState,
            lastActiveAt: serverTimestamp(),
          };

          if (pending) {
            data.missionCompletionHistory = arrayUnion(pending);
            pendingCompletionRef.current = null;
          } else {
            data.missionCompletionHistory = streakSessionRef.current?.history ?? [];
          }

          await setDoc(doc(db, 'users', user.uid), data, { merge: true });
        } catch (e) {
          console.error("Cloud sync error:", e);
        }
      };
      
      const timer = setTimeout(() => syncToCloud(), 1000); // Debounce saves
      return () => clearTimeout(timer);
    }
  }, [user, isDataLoaded, missionIndex, completedMissionsCount, totalXP, streak, longestStreak, hasCompletedToday, lastCompletedDate, appState, historyVersion]);

  return (
    <div className="min-h-screen bg-[#F4F4F1] flex items-center justify-center p-4">
      {/* Mobile Mockup Container */}
      <div className="w-full max-w-[393px] h-[852px] bg-[#FDFDFB] rounded-[56px] shadow-[0_48px_100px_-24px_rgba(0,0,0,0.15)] border-[8px] border-white relative flex flex-col items-center justify-between overflow-hidden font-sans text-[#1A1A1A]">
        
        <AnimatePresence>
          {saveError && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="absolute top-[48px] left-1/2 -translate-x-1/2 z-[200] bg-white/90 backdrop-blur-md px-4 py-2 rounded-full shadow-sm border border-black/5 flex items-center shrink-0 w-max"
            >
              <span className="text-[12px] font-medium tracking-wide text-[#A1A1A6]">saving issue, retrying...</span>
            </motion.div>
          )}
          
          {returnMsg && (
            <motion.div 
              key="returnMsg"
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -5, scale: 0.98 }}
              className="absolute top-[80px] left-1/2 -translate-x-1/2 z-[200] pointer-events-none flex items-center justify-center"
            >
              <span className="text-[14px] font-medium tracking-tight text-[#A1A1A6] italic">{returnMsg}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {appState === 'onboarding_1' ? (
            <Onboarding1Content key="onboarding1" onNext={() => setAppState('onboarding_2')} />
          ) : appState === 'onboarding_2' ? (
            <Onboarding2Content key="onboarding2" onComplete={() => setAppState('home')} />
          ) : appState === 'home' ? (
            <>
              <HomeContent key="home" level={Math.floor(totalXP / 100)} streak={streak} justIncreasedStreak={justIncreasedStreak} completedMissions={completedMissionsCount} onStart={() => setAppState('mission')} onChallenge={() => setAppState('challenge')} onInvite={() => setAppState('invite')} onProfile={() => setAppState('profile')} onStreakDetail={() => setAppState('streak_detail')} />
              {(showLoginSuggestion && (!user || user.isAnonymous || isLinking)) && <LoginPrompt setIsLinking={setIsLinking} onLoginSuccess={() => setShowLoginSuggestion(false)} />}
            </>
          ) : appState === 'streak_detail' ? (
            <StreakMomentumContent key="streak_detail" streak={streak} onBack={() => setAppState('home')} hasCompletedToday={hasCompletedToday} shouldCelebratePerfectWeek={shouldCelebratePerfectWeek} />
          ) : appState === 'profile' ? (
            <ProfileContent key="profile" totalXP={totalXP} streak={streak} longestStreak={longestStreak} completedMissions={completedMissionsCount} onBack={() => setAppState('home')} user={user} />
          ) : appState === 'mission' ? (
            <>
              <MissionContent key={`mission-${missionIndex}`} mission={getMissionData(missionIndex)} onComplete={() => {
                const earned = getMissionData(missionIndex).xp;
                
                const currentLevel = Math.floor(totalXP / 100);
                const nextLevel = Math.floor((totalXP + earned) / 100);
                
                if (analytics) {
                  logEvent(analytics, 'mission_completed', { mission_index: missionIndex, xp_earned: earned });
                  if (nextLevel > currentLevel) {
                    logEvent(analytics, 'level_up', { new_level: nextLevel });
                  }
                }
                
                setLastEarnedXP(earned);
                setTotalXP(prev => prev + earned);
                setCompletedMissionsCount(prev => prev + 1);
                
                const base =
                  streakSessionRef.current ??
                  syncStreakFromRemote(
                    {
                      streak,
                      longestStreak,
                      hasCompletedToday,
                      lastCompletedDate,
                    },
                    getTodayUtcKey(),
                  );
                const { session, result, firestoreEntry } = handleMissionStreakUpdate(base, missionIndex);
                applyStreakSession(session);
                setJustIncreasedStreak(result.streakIncreased);
                if (result.isNewCompletionDay) {
                  pendingCompletionRef.current = firestoreEntry;
                }
                
                setAppState('reward');
              }} 
              onGoBack={() => {
                setAppState('home');
                triggerReturnFeedback();
              }}
              />
              {(showLoginSuggestion && (!user || user.isAnonymous || isLinking)) && <LoginPrompt setIsLinking={setIsLinking} onLoginSuccess={() => setShowLoginSuggestion(false)} />}
            </>
          ) : appState === 'reward' ? (
            <>
              <RewardContent 
                key={`reward-${missionIndex}`}
                earnedXP={lastEarnedXP}
                leveledUp={Math.floor(totalXP / 100) > Math.floor((totalXP - lastEarnedXP) / 100)}
                streak={streak}
                streakIncreased={justIncreasedStreak}
                isCycleComplete={missionIndex % 12 === 11}
                isFirstMission={missionIndex === 0}
                isEarlyProgression={missionIndex > 0 && missionIndex <= 3}
                cycle={Math.floor(missionIndex / 12) + 1}
                onContinue={() => {
                  setMissionIndex(prev => prev + 1);
                  setAppState('mission');
                  setShowLoginSuggestion(true);
                }} 
                onGoBack={() => {
                  setMissionIndex(prev => prev + 1);
                  setAppState('home');
                  triggerReturnFeedback();
                  setShowLoginSuggestion(true);
                }} 
              />
              {(showLoginSuggestion && (!user || user.isAnonymous || isLinking)) && <LoginPrompt setIsLinking={setIsLinking} onLoginSuccess={() => setShowLoginSuggestion(false)} />}
            </>
          ) : appState === 'challenge' || appState === 'invite' ? (
            <ChallengeLobbyContent key="challenge_lobby" onBack={() => setAppState('home')} onStartMatch={(name) => { setOpponentName(name); setAppState('match_1v1'); }} />
          ) : appState === 'match_1v1' ? (
            <Match1v1Content key="match_1v1" opponentName={opponentName} userStreak={streak} onFinish={(u, o) => { setMatchScores({user: u, opponent: o}); setAppState('match_result'); }} />
          ) : (
            <MatchResultContent key="match_result" userScore={matchScores.user} opponentScore={matchScores.opponent} opponentName={opponentName} onRematch={() => { setMatchScores({user:0,opponent:0}); setAppState('match_1v1'); }} onInvite={() => setAppState('invite')} onHome={() => setAppState('home')} />
          )}
        </AnimatePresence>

        {/* Home Indicator Handle */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 w-32 h-1.5 bg-[#1A1A1A]/5 rounded-full z-50 pointer-events-none" />
        
        {/* Decorative background glows */}
        <div className="absolute -right-20 top-40 w-40 h-40 bg-[#6366F1]/5 rounded-full blur-3xl pointer-events-none z-0" />
        <div className="absolute -left-20 bottom-40 w-40 h-40 bg-[#6366F1]/5 rounded-full blur-3xl pointer-events-none z-0" />
      </div>
    </div>
  );
}
