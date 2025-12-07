import React, { useState, useEffect, useRef, useMemo } from 'react';
import 'katex/dist/katex.min.css';
import katex from 'katex';

// LaTeX equations - use String.raw to preserve backslashes
const TEX = {
  tfr: String.raw`\text{TFR} = \sum_{a=15}^{49} \text{ASFR}(a) = \sum_{a=15}^{49} \frac{B(a)}{W(a)}`,
  mckendrick: String.raw`\frac{\partial n(a,t)}{\partial t} + \frac{\partial n(a,t)}{\partial a} = -\mu(a) \cdot n(a,t)`,
  birth: String.raw`n(0,t) = \int_0^{\infty} \beta(a) \cdot n(a,t) \, da`,
  fertility: String.raw`\beta(a) = \frac{\text{TFR}}{Z} \cdot \exp\left(-\frac{(a-\mu)^2}{2\sigma^2}\right)`,
  siler: String.raw`\mu(a) = \alpha_1 e^{-\beta_1 a} + \alpha_2 + \alpha_3 e^{\beta_3 a}`,
  survival: String.raw`l(a) = \exp\left(-\int_0^a \mu(s) \, ds\right)`,
  lifeExp: String.raw`e_0 = \int_0^{\infty} l(a) \, da`,
  R0: String.raw`R_0 = f_f \int_0^{\infty} \beta(a) \cdot l(a) \, da`,
  genTime: String.raw`\bar{T} = \frac{\int a \cdot \beta(a) \cdot n(a,t) \, da}{\int \beta(a) \cdot n(a,t) \, da}`,
  intrinsic: String.raw`r \approx \frac{\ln(R_0)}{\bar{T}}`,
  dependency: String.raw`\text{DR} = \frac{N_{0\text{-}14} + N_{65+}}{N_{15\text{-}64}}`
};

const ReproductiveAgeExplorer = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [scrubIndex, setScrubIndex] = useState(null); // null = live view, number = viewing history index
  const [isPlayingHistory, setIsPlayingHistory] = useState(false); // Playing back history
  const intervalRef = useRef(null);
  const simulateStepRef = useRef(null); // Ref to always have latest simulateStep

  // UI State - collapsible sections
  const [showControls, setShowControls] = useState(true);
  
  // Resizable panels - store heights in pixels
  const [controlsPanelHeight, setControlsPanelHeight] = useState(350); // Default height
  const [vizPanelHeight, setVizPanelHeight] = useState(500); // Default visualization height
  const [draggingPanel, setDraggingPanel] = useState(null); // 'controls' or 'viz'
  const [dragStartY, setDragStartY] = useState(0);
  const [dragStartHeight, setDragStartHeight] = useState(0);

  // Scenarios for reproductive age distribution
  const [scenario, setScenario] = useState('baseline');
  
  // Y-axis range locking - stores the max values seen so far to prevent squishing
  const [yAxisRanges, setYAxisRanges] = useState({
    population: { min: 0, max: 10000 },
    birthsDeath: { min: 0, max: 100 }
  });
  
  // === DEMOGRAPHIC CONSTANTS ===
  const numAges = 100;
  // Biological sex ratio at birth: ~1.05 M:F (0.512 male, 0.488 female)
  const biologicalSRBFemale = 0.488; // Biological baseline
  
  const [ageDistribution, setAgeDistribution] = useState([]);
  const [maleDistribution, setMaleDistribution] = useState([]); // Track males separately
  const [femaleDistribution, setFemaleDistribution] = useState([]); // Track females separately
  const [history, setHistory] = useState([]);
  const [selectedPlot, setSelectedPlot] = useState('age-dist'); // Tab state for visualizations
  
  // === ADJUSTABLE PARAMETERS ===
  const [totalFertility, setTotalFertility] = useState(2.1); // TFR
  const [lifeExpectancy, setLifeExpectancy] = useState(75); // e₀
  const [fertilitySpread, setFertilitySpread] = useState(7); // σ for fertility curve
  const [peakFertilityAge, setPeakFertilityAge] = useState(27); // mode of fertility
  const [sexRatioBirth, setSexRatioBirth] = useState(0.488); // Proportion female at birth
  const [initialPopulation, setInitialPopulation] = useState(10000); // Initial population size
  const [simulationSpeed, setSimulationSpeed] = useState(10); // Years per second
  
  // Debug state
  const [debugInfo, setDebugInfo] = useState({});

  // Scenario presets
  const scenarios = {
    baseline: {
      name: "Baseline",
      description: "Standard fertility pattern with peak at 27.",
      peakAge: 27,
      spread: 7,
      color: '#8b5cf6'
    },
    early: {
      name: "Early Reproduction",
      description: "Younger childbearing (peak 21). Shorter generation time.",
      peakAge: 21,
      spread: 5,
      color: '#22c55e'
    },
    late: {
      name: "Delayed Reproduction",
      description: "Later childbearing (peak 33). Longer generation time.",
      peakAge: 33,
      spread: 6,
      color: '#f59e0b'
    },
    bimodal: {
      name: "Bimodal",
      description: "Two peaks at 20 and 35. Complex dynamics.",
      peakAge: 20,
      secondPeak: 35,
      spread: 4,
      color: '#ec4899'
    },
    custom: {
      name: "Custom",
      description: "Use sliders to set your own parameters.",
      peakAge: 27,
      spread: 7,
      color: '#06b6d4'
    }
  };

  // === MORTALITY MODEL ===
  // Siler mortality model: μ(a) = α₁exp(-β₁a) + α₂ + α₃exp(β₃a)
  // Three components: Infant (declining) + Background (constant) + Senescent (Gompertz)
  // Parameterized by life expectancy e₀
  // 
  // Sex-differential mortality using COMPONENT-SPECIFIC MULTIPLIERS
  // This approach applies different male excess factors to each Siler component,
  // reflecting the distinct biological/behavioral causes of each:
  //
  // 1. Infant component (α₁exp(-β₁a)): Male multiplier ~1.2×
  //    - Male biological fragility: weaker immune response, X-chromosome vulnerability
  //    - Well-documented in neonatal/infant mortality data globally
  //
  // 2. Background/Makeham component (α₂): Male multiplier ~1.5×
  //    - Accidents, violence, risk-taking behavior
  //    - This creates the "accident hump" in young adult male mortality
  //    - Largest sex differential, especially ages 15-35
  //
  // 3. Senescent/Gompertz component (α₃exp(β₃a)): Male multiplier ~1.15×
  //    - Cardiovascular disease differences
  //    - Estrogen protective effects in females
  //    - Gap narrows at very old ages (survivor selection)
  //
  // These multipliers produce ~5-6 year female life expectancy advantage,
  // consistent with empirical demographic data.
  
  const MALE_INFANT_MULTIPLIER = 1.20;      // Biological fragility
  const MALE_BACKGROUND_MULTIPLIER = 1.50;  // Accidents, violence, risk-taking
  const MALE_SENESCENT_MULTIPLIER = 1.15;   // Cardiovascular, aging differences
  
  const getMortalityRate = (age, e0, isMale = false) => {
    // Infant mortality: α₁exp(-β₁a)
    // Declines exponentially from birth, captures neonatal/infant vulnerability
    // Scales with e₀ (historical low e₀ had high infant mortality)
    const alpha1 = 0.015 * Math.exp((75 - e0) * 0.055);
    const beta1 = 0.7;
    const infantMortality = alpha1 * Math.exp(-beta1 * age);
    
    // Background (Makeham) mortality: α₂
    // Age-independent component: accidents, endemic disease, violence
    const alpha2 = 0.0004 * Math.exp((75 - e0) * 0.015);
    
    // Senescent mortality: α₃exp(β₃a) (Gompertz)
    // Exponentially increasing with age - biological aging
    // β₃ (Gompertz slope) ~0.085-0.095, fairly constant across populations
    const beta3 = 0.088;
    const alpha3 = 0.00002 * Math.exp((80 - e0) * 0.055);
    const senescentMortality = alpha3 * Math.exp(beta3 * age);
    
    // Apply sex-specific component multipliers
    // Each component has different male excess based on its etiology
    let mortality;
    if (isMale) {
      mortality = (infantMortality * MALE_INFANT_MULTIPLIER) + 
                  (alpha2 * MALE_BACKGROUND_MULTIPLIER) + 
                  (senescentMortality * MALE_SENESCENT_MULTIPLIER);
    } else {
      mortality = infantMortality + alpha2 + senescentMortality;
    }
    
    // Cap at 0.6 to prevent numerical issues
    return Math.min(mortality, 0.6);
  };

  // Calculate survival curve l(a) = probability of surviving to age a
  // Using exponential survival: l(a) = l(a-1) × exp(-μ(a-1))
  // This is more accurate than linear approximation for discrete time steps
  const getSurvivalCurve = (e0, isMale = false) => {
    const survival = new Array(numAges).fill(1);
    for (let age = 1; age < numAges; age++) {
      const mortality = getMortalityRate(age - 1, e0, isMale);
      survival[age] = survival[age - 1] * Math.exp(-mortality);
    }
    return survival;
  };

  // Calculate actual life expectancy from survival curve
  const calculateLifeExpectancy = (survivalCurve) => {
    return survivalCurve.reduce((sum, l) => sum + l, 0);
  };

  // === FERTILITY MODEL ===
  // Age-Specific Fertility Rate: β(a) ~ Gaussian centered at peak
  // Based on Coale-Trussell fertility model structure
  // Normalized so that Σβ(a) = TFR, with biological maximum constraint
  
  // Biological maximum ASFR: ~1.1 births per woman per year
  // Based on ~9 months gestation + ~1-2 months minimum postpartum recovery
  // This caps the maximum possible births regardless of how narrow the fertility window
  const MAX_ASFR = 1.1;
  
  const getFertilitySchedule = (peak, spreadVal, secondPeak = null, tfr = 2.1) => {
    let schedule = new Array(numAges).fill(0);
    const sigma = Math.max(spreadVal, 2.5); // Minimum spread for numerical stability
    
    // Biological fertility window: menarche ~12-13, menopause ~48-52
    for (let age = 12; age < 55; age++) {
      // Primary peak (Gaussian)
      const primary = Math.exp(-((age - peak) ** 2) / (2 * sigma ** 2));
      
      // Secondary peak if bimodal (for modeling e.g., teen + delayed childbearing)
      let secondary = 0;
      if (secondPeak && Math.abs(secondPeak - peak) > 5) {
        secondary = Math.exp(-((age - secondPeak) ** 2) / (2 * sigma ** 2)) * 0.6;
      }
      
      // Biological decline after age 40 (declining oocyte quality/quantity)
      let biologicalDecline = 1.0;
      if (age > 40) {
        biologicalDecline = Math.exp(-0.1 * (age - 40));
      }
      
      schedule[age] = (primary + secondary) * biologicalDecline;
    }
    
    // Normalize so that sum(ASFR) = TFR
    const sum = schedule.reduce((a, b) => a + b, 0);
    if (sum < 1e-10) return schedule; // Avoid division by zero
    schedule = schedule.map(f => (f / sum) * tfr);
    
    // Apply biological maximum constraint (gestation + recovery limits)
    // If any age exceeds MAX_ASFR, cap it and redistribute across fertile ages
    const capped = schedule.map(f => Math.min(f, MAX_ASFR));
    const totalCapped = capped.reduce((a, b) => a + b, 0);
    const isCapped = totalCapped < tfr * 0.99;
    
    // If we hit the biological cap, redistribute the excess proportionally
    let redistributed = capped;
    if (isCapped) {
      // Calculate how much fertility was lost due to capping
      const lostFertility = tfr - totalCapped;
      // Find fertile ages that aren't at the cap
      const canReceive = capped.map((f, a) => f < MAX_ASFR && a >= 12 && a < 55);
      const numCanReceive = canReceive.filter(x => x).length;
      
      if (numCanReceive > 0) {
        // Distribute the lost fertility proportionally among ages that can receive it
        redistributed = capped.map((f, a) => {
          if (canReceive[a]) {
            return Math.min(f + (lostFertility / numCanReceive), MAX_ASFR);
          }
          return f;
        });
      }
    }
    
    // Store whether we hit the biological cap for UI feedback
    redistributed.biologicallyCapped = isCapped;
    redistributed.effectiveTFR = redistributed.reduce((a, b) => a + b, 0);
    
    return redistributed;
  };

  // === DERIVED QUANTITIES ===
  // Female survival curve (baseline - used for R₀ calculation)
  const survivalCurve = useMemo(() => getSurvivalCurve(lifeExpectancy, false), [lifeExpectancy]);
  // Male survival curve (higher mortality)
  const maleSurvivalCurve = useMemo(() => getSurvivalCurve(lifeExpectancy, true), [lifeExpectancy]);
  
  const mortalityCurve = useMemo(() => 
    Array.from({ length: numAges }, (_, a) => getMortalityRate(a, lifeExpectancy, false)), 
    [lifeExpectancy]
  );
  
  // Sex-specific life expectancies
  const femaleE0 = useMemo(() => calculateLifeExpectancy(survivalCurve), [survivalCurve]);
  const maleE0 = useMemo(() => calculateLifeExpectancy(maleSurvivalCurve), [maleSurvivalCurve]);
  const actualE0 = femaleE0; // Use female e₀ as the reference (slider controls female mortality)

  // Get effective parameters (from scenario or custom)
  const getEffectiveParams = () => {
    if (scenario === 'custom') {
      return { peakAge: peakFertilityAge, spread: fertilitySpread, secondPeak: null };
    }
    return scenarios[scenario];
  };

  // Find median age of population
  const findMedianAge = (dist) => {
    const total = dist.reduce((a, b) => a + b, 0);
    let cumulative = 0;
    for (let age = 0; age < numAges; age++) {
      cumulative += dist[age];
      if (cumulative >= total / 2) return age;
    }
    return 50;
  };

  // Initialize population with stable age structure
  const initialize = () => {
    const params = getEffectiveParams();
    
    // Initialize with survival-weighted age structure
    // Scale so total population equals initialPopulation
    const rawInitial = new Array(numAges).fill(0).map((_, age) => survivalCurve[age]);
    const rawTotal = rawInitial.reduce((a, b) => a + b, 0);
    const scaleFactor = initialPopulation / rawTotal;
    const initial = rawInitial.map(n => n * scaleFactor);
    
    // Calculate initial debug info
    const fertilitySchedule = getFertilitySchedule(
      params.peakAge, params.spread, params.secondPeak || null, totalFertility
    );
    
    let initialBirths = 0;
    let weightedAgeSum = 0;
    for (let age = 12; age < 55; age++) {
      // Use biological ~50% female for calculating women at each age
      // (sexRatioBirth only affects R₀ calculation, not simulation dynamics)
      const births = fertilitySchedule[age] * initial[age] * 0.5;
      initialBirths += births;
      weightedAgeSum += age * births;
    }
    
    let initialDeaths = 0;
    for (let age = 0; age < numAges; age++) {
      // Use exponential mortality for consistency
      const mortality = getMortalityRate(age, lifeExpectancy);
      initialDeaths += initial[age] * (1 - Math.exp(-mortality));
    }
    
    const meanParentAge = initialBirths > 0 ? weightedAgeSum / initialBirths : params.peakAge;
    
    const young = initial.slice(0, 15).reduce((a, b) => a + b, 0);
    const old = initial.slice(65).reduce((a, b) => a + b, 0);
    const working = initial.slice(15, 65).reduce((a, b) => a + b, 0);
    const depRatio = working > 0 ? (young + old) / working : 0;
    
    setDebugInfo({
      births: initialBirths,
      deaths: initialDeaths,
      birthDeathRatio: initialDeaths > 0 ? initialBirths / initialDeaths : 0,
      fertilitySum: fertilitySchedule.reduce((a, b) => a + b, 0),
      maxASFR: Math.max(...fertilitySchedule),
      peakAge: fertilitySchedule.indexOf(Math.max(...fertilitySchedule)),
      fertileWomen: initial.slice(15, 50).reduce((a, b) => a + b, 0) * 0.5,
      dependencyRatio: depRatio,
      medianAge: findMedianAge(initial),
      actualE0: actualE0
    });
    
    setAgeDistribution(initial);
    // Initialize sex distributions at ~50/50 (stable population assumption)
    const initialMale = initial.map(n => n * 0.5);
    const initialFemale = initial.map(n => n * 0.5);
    setMaleDistribution(initialMale);
    setFemaleDistribution(initialFemale);
    setTime(0);
    setScrubIndex(null); // Back to live view
    const initialPop = initial.reduce((a, b) => a + b, 0);
    setHistory([{
      time: 0,
      population: initialPop,
      births: initialBirths,
      deaths: initialDeaths,
      meanParentAge,
      dependencyRatio: depRatio,
      ageDistribution: [...initial], // Store full age distribution for time scrubbing
      maleDistribution: [...initialMale],
      femaleDistribution: [...initialFemale],
      // Store model parameters at initialization
      lifeExpectancy,
      totalFertility,
      peakFertilityAge,
      fertilitySpread,
      sexRatioBirth
    }]);
    // Reset Y-axis ranges
    setYAxisRanges({
      population: { min: initialPop * 0.9, max: initialPop * 1.1 },
      birthsDeath: { min: 0, max: Math.max(initialBirths, initialDeaths) * 1.2 }
    });
  };

  useEffect(() => {
    initialize();
  }, [scenario]);  // Reinitialize on scenario change (sex ratio only affects R₀, not simulation)

  // Handle resize dragging for panels
  useEffect(() => {
    if (!draggingPanel) return;
    
    const handleMouseMove = (e) => {
      const deltaY = e.clientY - dragStartY;
      const newHeight = Math.max(150, Math.min(800, dragStartHeight + deltaY));
      
      if (draggingPanel === 'controls') {
        setControlsPanelHeight(newHeight);
      } else if (draggingPanel === 'viz') {
        setVizPanelHeight(newHeight);
      }
    };
    
    const handleMouseUp = () => {
      setDraggingPanel(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingPanel, dragStartY, dragStartHeight]);

  const startDrag = (panel, currentHeight) => (e) => {
    e.preventDefault();
    setDraggingPanel(panel);
    setDragStartY(e.clientY);
    setDragStartHeight(currentHeight);
  };

  // Simulation step: McKendrick-von Foerster PDE
  const simulateStep = () => {
    const params = getEffectiveParams();
    
    // Get current fertility schedule
    const fertilitySchedule = getFertilitySchedule(
      params.peakAge,
      params.spread,
      params.secondPeak || null,
      totalFertility
    );

    // Calculate all new distributions synchronously before updating state
    // This ensures consistency across male, female, and total distributions
    
    // Calculate births from current female population
    let births = 0;
    let weightedAgeSum = 0;
    for (let age = 12; age < 55; age++) {
      const asfr = fertilitySchedule[age];
      const birthsFromAge = asfr * femaleDistribution[age];
      births += birthsFromAge;
      weightedAgeSum += age * birthsFromAge;
    }
    const meanParentAge = births > 0 ? weightedAgeSum / births : params.peakAge;
    
    // Calculate new female distribution (using female mortality rates)
    const newFemale = new Array(numAges).fill(0);
    newFemale[0] = births * sexRatioBirth; // Female births
    for (let age = 1; age < numAges; age++) {
      const mortality = getMortalityRate(age - 1, lifeExpectancy, false); // Female mortality
      const survivalProb = Math.exp(-mortality);
      newFemale[age] = Math.max(0, femaleDistribution[age - 1] * survivalProb);
    }
    
    // Calculate new male distribution (using male mortality rates - higher)
    const newMale = new Array(numAges).fill(0);
    newMale[0] = births * (1 - sexRatioBirth); // Male births
    for (let age = 1; age < numAges; age++) {
      const mortality = getMortalityRate(age - 1, lifeExpectancy, true); // Male mortality (higher)
      const survivalProb = Math.exp(-mortality);
      newMale[age] = Math.max(0, maleDistribution[age - 1] * survivalProb);
    }
    
    // Calculate new total distribution and deaths
    const newDist = new Array(numAges).fill(0);
    newDist[0] = births;
    let deaths = 0;
    for (let age = 1; age < numAges; age++) {
      const mortality = getMortalityRate(age - 1, lifeExpectancy);
      const survivalProb = Math.exp(-mortality);
      const survivors = ageDistribution[age - 1] * survivalProb;
      newDist[age] = Math.max(0, survivors);
      deaths += ageDistribution[age - 1] * (1 - survivalProb);
    }
    deaths += ageDistribution[numAges - 1]; // Deaths from oldest age group
    
    // Calculate dependency ratio
    const young = newDist.slice(0, 15).reduce((a, b) => a + b, 0);
    const old = newDist.slice(65).reduce((a, b) => a + b, 0);
    const working = newDist.slice(15, 65).reduce((a, b) => a + b, 0);
    const dependencyRatio = working > 0 ? (young + old) / working : 0;
    
    const newPop = newDist.reduce((a, b) => a + b, 0);
    
    // Update all state at once
    setFemaleDistribution(newFemale);
    setMaleDistribution(newMale);
    setAgeDistribution(newDist);
    
    // Update debug info
    setDebugInfo({
      births,
      deaths,
      birthDeathRatio: deaths > 0 ? births / deaths : 0,
      fertilitySum: fertilitySchedule.reduce((a, b) => a + b, 0),
      maxASFR: Math.max(...fertilitySchedule),
      peakAge: fertilitySchedule.indexOf(Math.max(...fertilitySchedule)),
      fertileWomen: femaleDistribution.slice(12, 55).reduce((a, b) => a + b, 0),
      dependencyRatio,
      medianAge: findMedianAge(newDist),
      actualE0
    });
    
    // Update Y-axis ranges (only expand, never shrink while running)
    setYAxisRanges(ranges => ({
      population: {
        min: Math.min(ranges.population.min, newPop * 0.95),
        max: Math.max(ranges.population.max, newPop * 1.05)
      },
      birthsDeath: {
        min: 0,
        max: Math.max(ranges.birthsDeath.max, births * 1.1, deaths * 1.1)
      }
    }));
    
    // Record history
    setHistory(h => {
      const updated = [...h, {
        time: time + 1,
        population: newPop,
        births,
        deaths,
        meanParentAge,
        dependencyRatio,
        ageDistribution: [...newDist],
        maleDistribution: [...newMale],
        femaleDistribution: [...newFemale],
        // Store model parameters at this point in time
        lifeExpectancy,
        totalFertility,
        peakFertilityAge,
        fertilitySpread,
        sexRatioBirth
      }];
      return updated;
    });
    
    setTime(t => t + 1);
  };

  // Handle time scrubbing - navigate to a specific point in history
  const handleTimeScrub = (index) => {
    if (index >= 0 && index < history.length) {
      setScrubIndex(index);
    }
  };

  // Jump to live (latest) view
  const jumpToLive = () => {
    setScrubIndex(null);
  };

  // Determine what to display: live state or scrubbed history
  // isViewingHistory is true when user has navigated to any point in history (scrubIndex not null)
  const isViewingHistory = scrubIndex !== null;
  const displayedHistoryEntry = scrubIndex !== null ? history[scrubIndex] : history[history.length - 1];
  const displayedAgeDist = scrubIndex !== null && displayedHistoryEntry?.ageDistribution 
    ? displayedHistoryEntry.ageDistribution 
    : ageDistribution;
  const displayedMaleDist = scrubIndex !== null && displayedHistoryEntry?.maleDistribution
    ? displayedHistoryEntry.maleDistribution
    : maleDistribution;
  const displayedFemaleDist = scrubIndex !== null && displayedHistoryEntry?.femaleDistribution
    ? displayedHistoryEntry.femaleDistribution
    : femaleDistribution;

  // Keep simulateStep ref updated with latest function
  simulateStepRef.current = simulateStep;

  useEffect(() => {
    if (isPlaying) {
      // Convert years per second to milliseconds per step
      const msPerStep = 1000 / simulationSpeed;
      // Use ref to always call the latest version of simulateStep
      intervalRef.current = setInterval(() => simulateStepRef.current(), msPerStep);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [isPlaying, simulationSpeed]);

  // History playback effect
  useEffect(() => {
    if (isPlayingHistory && history.length > 0) {
      const msPerStep = 1000 / simulationSpeed;
      const playbackInterval = setInterval(() => {
        setScrubIndex((prevIndex) => {
          const current = prevIndex ?? history.length - 1;
          const next = current + 1;
          // Stop playback when reaching the end
          if (next >= history.length - 1) {
            setIsPlayingHistory(false);
            return history.length - 1;
          }
          return next;
        });
      }, msPerStep);
      return () => clearInterval(playbackInterval);
    }
  }, [isPlayingHistory, history.length, simulationSpeed]);

  const reset = () => {
    setIsPlaying(false);
    initialize();
  };

  // Current derived values
  const params = getEffectiveParams();
  const config = scenarios[scenario];
  const currentFertilitySchedule = getFertilitySchedule(
    params.peakAge, params.spread, params.secondPeak, totalFertility
  );
  
  // Calculate display values from displayed distribution
  const totalPop = displayedAgeDist.reduce((a, b) => a + b, 0);
  const maxDist = Math.max(...displayedAgeDist, 100);
  
  const lastHistory = history[history.length - 1] || {};
  const generationTime = (displayedHistoryEntry?.meanParentAge) || params.peakAge;
  
  const growthRate = history.length > 10 
    ? ((history[history.length - 1]?.population / history[history.length - 10]?.population) - 1) * 100 / 10
    : 0;

  // Net Reproduction Rate: R₀ = SRB_female × ∫ β(a) × l(a) da
  // This is the expected number of daughters per woman
  // R₀ > 1 means long-term population growth, R₀ < 1 means decline
  const netReproductionRate = currentFertilitySchedule.reduce((sum, beta, age) => {
    return sum + sexRatioBirth * beta * survivalCurve[age];
  }, 0);
  
  // Approximate intrinsic growth rate r (Lotka's r)
  // Using the approximation: r ≈ ln(R₀) / T̄
  const intrinsicGrowthRate = generationTime > 0 
    ? Math.log(netReproductionRate) / generationTime 
    : 0;

  // Export functions
  const exportToCSV = () => {
    if (history.length === 0) return;
    
    // Prepare summary header
    const summary = [
      ['Demographic Simulation Export'],
      ['Generated:', new Date().toISOString()],
      ['Final Year:', time],
      ['Final Population:', totalPop.toLocaleString()],
      [''],
      ['Time', 'Population', 'Births', 'Deaths', 'Mean Parent Age', 'Dependency Ratio', 'Life Expectancy', 'Total Fertility', 'Peak Fertility Age', 'Fertility Spread', 'Sex Ratio at Birth']
    ];
    
    // Add history data
    const rows = summary.concat(history.map(h => [
      h.time,
      h.population.toFixed(0),
      h.births.toFixed(2),
      h.deaths.toFixed(2),
      h.meanParentAge.toFixed(2),
      h.dependencyRatio.toFixed(4),
      h.lifeExpectancy || '-',
      h.totalFertility || '-',
      h.peakFertilityAge || '-',
      h.fertilitySpread || '-',
      h.sexRatioBirth?.toFixed(3) || '-'
    ]));
    
    const csv = rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `demographic-simulation-${new Date().getTime()}.csv`;
    link.click();
  };

  const exportToJSON = () => {
    if (history.length === 0) return;
    
    const data = {
      metadata: {
        generatedAt: new Date().toISOString(),
        finalYear: time,
        finalPopulation: totalPop,
        scenarioName: scenario,
        yearsSimulated: history.length
      },
      history: history.map(h => ({
        time: h.time,
        population: h.population,
        births: h.births,
        deaths: h.deaths,
        meanParentAge: h.meanParentAge,
        dependencyRatio: h.dependencyRatio,
        lifeExpectancy: h.lifeExpectancy,
        totalFertility: h.totalFertility,
        peakFertilityAge: h.peakFertilityAge,
        fertilitySpread: h.fertilitySpread,
        sexRatioBirth: h.sexRatioBirth
      }))
    };
    
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `demographic-simulation-${new Date().getTime()}.json`;
    link.click();
  };

  const exportToXLSX = () => {
    if (history.length === 0) return;
    
    // Generate simple Excel XML format
    const rows = [
      ['Demographic Simulation Export'],
      ['Generated:', new Date().toISOString()],
      ['Final Year:', time],
      ['Final Population:', totalPop.toLocaleString()],
      [''],
      ['Time', 'Population', 'Births', 'Deaths', 'Mean Parent Age', 'Dependency Ratio', 'Life Expectancy', 'Total Fertility', 'Peak Fertility Age', 'Fertility Spread', 'Sex Ratio at Birth']
    ];
    
    history.forEach(h => {
      rows.push([
        h.time,
        h.population.toFixed(0),
        h.births.toFixed(2),
        h.deaths.toFixed(2),
        h.meanParentAge.toFixed(2),
        h.dependencyRatio.toFixed(4),
        h.lifeExpectancy || '',
        h.totalFertility || '',
        h.peakFertilityAge || '',
        h.fertilitySpread || '',
        h.sexRatioBirth?.toFixed(3) || ''
      ]);
    });
    
    // Create XML workbook
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
    xml += '<Worksheet ss:Name="Simulation">\n';
    xml += '<Table>\n';
    
    rows.forEach(row => {
      xml += '<Row>\n';
      row.forEach(cell => {
        const cellValue = String(cell).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        xml += `<Cell><Data ss:Type="String">${cellValue}</Data></Cell>\n`;
      });
      xml += '</Row>\n';
    });
    
    xml += '</Table>\n';
    xml += '</Worksheet>\n';
    xml += '</Workbook>';
    
    const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `demographic-simulation-${new Date().getTime()}.xlsx`;
    link.click();
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#08080c',
      fontFamily: '"IBM Plex Sans", -apple-system, sans-serif',
      color: '#e2e8f0',
      padding: '25px 20px'
    }}>
      {/* Header */}
      <header style={{ textAlign: 'center', marginBottom: '25px' }}>
        <h1 style={{ fontSize: '1.8rem', fontWeight: 600, marginBottom: '8px', color: '#f8fafc' }}>
          Demographic Dynamics Explorer
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '0.95rem' }}>
          McKendrick-von Foerster population model with age-structured fertility and mortality
        </p>
      </header>

      <div style={{ maxWidth: '1800px', margin: '0 auto', display: 'flex', gap: '20px' }}>
        
        {/* Left Sidebar - Model Parameters */}
        <div style={{
          width: '320px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '15px',
          maxHeight: 'calc(100vh - 150px)',
          overflowY: 'auto',
          position: 'sticky',
          top: '20px'
        }}>
          {/* Playback Controls - at top for visibility */}
          <div style={{
            background: '#111116',
            borderRadius: '12px',
            padding: '15px'
          }}>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => setIsPlaying(!isPlaying)}
                style={{
                  padding: '10px 20px',
                  borderRadius: '8px',
                  border: 'none',
                  background: isPlaying ? '#ef4444' : '#22c55e',
                  color: '#fff',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontSize: '0.9rem'
                }}
              >
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
              <button
                onClick={simulateStep}
                disabled={isPlaying}
                style={{
                  padding: '10px 16px',
                  borderRadius: '8px',
                  border: '1px solid #333',
                  background: '#1a1a22',
                  color: '#94a3b8',
                  cursor: isPlaying ? 'not-allowed' : 'pointer',
                  opacity: isPlaying ? 0.5 : 1
                }}
              >
                Step →
              </button>
              <button
                onClick={reset}
                style={{
                  padding: '10px 16px',
                  borderRadius: '8px',
                  border: '1px solid #333',
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: 'pointer'
                }}
              >
                ↺ Reset
              </button>
            </div>
          </div>

          {/* Scenario selector */}
          <div style={{
            background: '#111116',
            borderRadius: '12px',
            padding: '15px'
          }}>
            <h3 style={{ color: '#f8fafc', fontSize: '0.9rem', marginBottom: '12px' }}>Scenarios</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {Object.entries(scenarios).map(([key, s]) => (
                <button
                  key={key}
                  onClick={() => setScenario(key)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: scenario === key ? `2px solid ${s.color}` : '1px solid #2a2a35',
                    background: scenario === key ? `${s.color}15` : 'transparent',
                    color: scenario === key ? s.color : '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                    textAlign: 'left'
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          {/* Model Parameters */}
          <div style={{
            background: '#111116',
            borderRadius: '12px',
            padding: '15px',
            display: 'flex',
            flexDirection: 'column',
            gap: '15px'
          }}>
            <h3 style={{ color: '#f8fafc', fontSize: '0.9rem', margin: 0 }}>Model Parameters</h3>
            
            {/* TFR Slider */}
            <SliderControl
              label="Total Fertility Rate (TFR)"
              value={totalFertility}
              onChange={setTotalFertility}
              min={0.8}
              max={6}
              step={0.1}
              equation="TFR = Σₐ β(a)"
              description="Lifetime births per woman"
              color="#22c55e"
              marks={[
                { value: 0.8, label: '0.8' },
                { value: 2.1, label: '2.1' },
                { value: 6, label: '6' }
              ]}
            />
            {currentFertilitySchedule.biologicallyCapped && (
              <div style={{
                padding: '8px 10px',
                background: 'rgba(251, 146, 60, 0.15)',
                border: '1px solid #fb923c',
                borderRadius: '6px',
                fontSize: '11px',
                color: '#fb923c'
              }}>
                ⚠️ Bio limit: Effective TFR = {currentFertilitySchedule.effectiveTFR?.toFixed(2)}
              </div>
            )}

            {/* Life Expectancy Slider */}
            <SliderControl
              label="Life Expectancy (e₀)"
              value={lifeExpectancy}
              onChange={setLifeExpectancy}
              min={30}
              max={95}
              step={1}
              equation="e₀ = ∫l(a)da"
              description="Expected years at birth"
              color="#f97316"
              marks={[
                { value: 30, label: '30' },
                { value: 60, label: '60' },
                { value: 95, label: '95' }
              ]}
            />

            {/* Sex Ratio Slider */}
            <SliderControl
              label="Sex Ratio at Birth (% Female)"
              value={sexRatioBirth}
              onChange={setSexRatioBirth}
              min={0.4}
              max={0.6}
              step={0.005}
              equation={`SRB = ${(sexRatioBirth * 100).toFixed(1)}% F`}
              description="Female fraction of births"
              color="#3b82f6"
              marks={[
                { value: 0.4, label: '40%' },
                { value: biologicalSRBFemale, label: '48.8%' },
                { value: 0.6, label: '60%' }
              ]}
            />

            {/* Custom Scenario Controls - only show when custom is selected */}
            {scenario === 'custom' && (
              <>
                {/* Peak Fertility Age Slider */}
                <SliderControl
                  label="Peak Fertility Age"
                  value={peakFertilityAge}
                  onChange={setPeakFertilityAge}
                  min={15}
                  max={50}
                  step={1}
                  equation="μ (mode of fertility)"
                  description="Age with highest fertility rate"
                  color="#ec4899"
                  marks={[
                    { value: 15, label: '15' },
                    { value: 27, label: '27' },
                    { value: 50, label: '50' }
                  ]}
                />

                {/* Fertility Spread Slider */}
                <SliderControl
                  label="Fertility Spread"
                  value={fertilitySpread}
                  onChange={setFertilitySpread}
                  min={2}
                  max={15}
                  step={0.5}
                  equation="σ (standard deviation)"
                  description="Width of fertility curve"
                  color="#06b6d4"
                  marks={[
                    { value: 2, label: '2' },
                    { value: 7, label: '7' },
                    { value: 15, label: '15' }
                  ]}
                />
              </>
            )}

            {/* Population Slider */}
            <SliderControl
              label="Initial Population"
              value={initialPopulation}
              onChange={setInitialPopulation}
              min={1000}
              max={100000}
              step={1000}
              equation="N(0)"
              description="Starting population size"
              color="#8b5cf6"
              marks={[
                { value: 1000, label: '1K' },
                { value: 50000, label: '50K' },
                { value: 100000, label: '100K' }
              ]}
            />

            {/* Simulation Speed Slider */}
            <SliderControl
              label="Simulation Speed"
              value={simulationSpeed}
              onChange={setSimulationSpeed}
              min={1}
              max={50}
              step={1}
              equation="years/second"
              description="Simulation years per real second"
              color="#a855f7"
              marks={[
                { value: 1, label: '1' },
                { value: 25, label: '25' },
                { value: 50, label: '50' }
              ]}
            />

            {/* Export Data Panel */}
            <div style={{
              background: '#1a1a22',
              border: '1px solid #333340',
              borderRadius: '8px',
              padding: '12px',
              marginTop: '8px'
            }}>
              <div style={{
                fontSize: '12px',
                fontWeight: '600',
                color: '#94a3b8',
                marginBottom: '8px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
              }}>
                📊 Export Data
              </div>
              <div style={{
                fontSize: '11px',
                color: '#64748b',
                marginBottom: '10px'
              }}>
                {history.length} years of data
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <button
                  onClick={exportToCSV}
                  disabled={history.length === 0}
                  style={{
                    padding: '8px 12px',
                    background: history.length === 0 ? '#1e293b' : '#06b6d4',
                    color: history.length === 0 ? '#64748b' : '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: '500',
                    cursor: history.length === 0 ? 'not-allowed' : 'pointer',
                    transition: 'background 0.2s',
                    opacity: history.length === 0 ? 0.5 : 1
                  }}
                  onMouseEnter={(e) => {
                    if (history.length > 0) e.target.style.background = '#0891b2';
                  }}
                  onMouseLeave={(e) => {
                    if (history.length > 0) e.target.style.background = '#06b6d4';
                  }}
                >
                  📋 CSV
                </button>
                <button
                  onClick={exportToJSON}
                  disabled={history.length === 0}
                  style={{
                    padding: '8px 12px',
                    background: history.length === 0 ? '#1e293b' : '#8b5cf6',
                    color: history.length === 0 ? '#64748b' : '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: '500',
                    cursor: history.length === 0 ? 'not-allowed' : 'pointer',
                    transition: 'background 0.2s',
                    opacity: history.length === 0 ? 0.5 : 1
                  }}
                  onMouseEnter={(e) => {
                    if (history.length > 0) e.target.style.background = '#7c3aed';
                  }}
                  onMouseLeave={(e) => {
                    if (history.length > 0) e.target.style.background = '#8b5cf6';
                  }}
                >
                  📄 JSON
                </button>
                <button
                  onClick={exportToXLSX}
                  disabled={history.length === 0}
                  style={{
                    padding: '8px 12px',
                    background: history.length === 0 ? '#1e293b' : '#ec4899',
                    color: history.length === 0 ? '#64748b' : '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: '500',
                    cursor: history.length === 0 ? 'not-allowed' : 'pointer',
                    transition: 'background 0.2s',
                    opacity: history.length === 0 ? 0.5 : 1
                  }}
                  onMouseEnter={(e) => {
                    if (history.length > 0) e.target.style.background = '#db2777';
                  }}
                  onMouseLeave={(e) => {
                    if (history.length > 0) e.target.style.background = '#ec4899';
                  }}
                >
                  📑 Excel
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Main Content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '15px', minWidth: 0 }}>
          
          {/* Key Metrics Bar */}
          <div style={{
            background: '#111116',
            borderRadius: '12px',
            padding: '15px 20px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
            gap: '10px'
          }}>
            <MetricBox label="Year" value={time} color="#f8fafc" />
            <MetricBox label="Population" value={totalPop.toLocaleString('en-US', {maximumFractionDigits: 0})} color="#6366f1" />
            <MetricBox label="Growth Rate" value={`${growthRate >= 0 ? '+' : ''}${growthRate.toFixed(4)}%/yr`} 
              color={growthRate > 0.05 ? '#22c55e' : growthRate < -0.05 ? '#ef4444' : '#94a3b8'} />
            <MetricBox label="Intrinsic r" value={`${(intrinsicGrowthRate * 100).toFixed(4)}%/yr`} 
              color={intrinsicGrowthRate > 0.001 ? '#22c55e' : intrinsicGrowthRate < -0.001 ? '#ef4444' : '#f59e0b'} />
            <MetricBox label="Gen T̄" value={`${generationTime.toFixed(1)} yr`} color={config.color} />
            <MetricBox label="R₀" value={netReproductionRate.toFixed(3)} 
              color={netReproductionRate > 1.01 ? '#22c55e' : netReproductionRate < 0.99 ? '#ef4444' : '#f59e0b'} />
            <MetricBox label="Dep. Ratio" value={(debugInfo.dependencyRatio || 0).toFixed(2)} color="#ec4899" />
            <MetricBox label="Median Age" value={`${debugInfo.medianAge || 0} yr`} color="#06b6d4" />
            <MetricBox label="e₀" value={`${actualE0.toFixed(1)} yr`} color="#f97316" />
          </div>

          {/* Time Scrubber */}
          {history.length > 1 && (
            <div style={{
              padding: '12px 15px',
              background: '#111116',
              borderRadius: '12px',
              border: isViewingHistory ? '2px solid #f59e0b' : '1px solid #2a2a35'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' }}>
                <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                  Year {displayedHistoryEntry?.time ?? time}
                </span>
                <span style={{ 
                  color: isViewingHistory ? '#f59e0b' : '#6366f1', 
                  fontSize: '0.8rem', 
                  fontWeight: 600 
                }}>
                  {isViewingHistory ? `(viewing history)` : `Live${isPlaying ? ' ▶' : ''}`}
                </span>
                <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
                  <button onClick={() => handleTimeScrub(0)} title="Start" style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: '#2a2a35', color: '#94a3b8', cursor: 'pointer', fontSize: '0.7rem' }}>⏮</button>
                  <button onClick={() => { const c = scrubIndex !== null ? scrubIndex : (history.length - 1); handleTimeScrub(Math.max(0, c - 1)); }} title="Back" style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: '#2a2a35', color: '#94a3b8', cursor: 'pointer', fontSize: '0.7rem' }}>⏪</button>
                  <button
                    onClick={() => {
                      if (isPlayingHistory) { setIsPlayingHistory(false); }
                      else { if (!isViewingHistory) { setScrubIndex(0); } setIsPlayingHistory(true); }
                    }}
                    style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: isPlayingHistory ? '#ef4444' : '#2a2a35', color: '#fff', cursor: 'pointer', fontSize: '0.7rem' }}
                  >{isPlayingHistory ? '⏸' : '▶'}</button>
                  {isViewingHistory && (
                    <button onClick={() => { setIsPlayingHistory(false); jumpToLive(); }} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: '#6366f1', color: '#fff', cursor: 'pointer', fontSize: '0.7rem' }}>Live</button>
                  )}
                  <button onClick={() => { const c = scrubIndex !== null ? scrubIndex : (history.length - 1); handleTimeScrub(Math.min(history.length - 1, c + 1)); }} title="Forward" style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: '#2a2a35', color: '#94a3b8', cursor: 'pointer', fontSize: '0.7rem' }}>⏩</button>
                  <button onClick={() => handleTimeScrub(history.length - 1)} title="End" style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: '#2a2a35', color: '#94a3b8', cursor: 'pointer', fontSize: '0.7rem' }}>⏭</button>
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(0, history.length - 1)}
                step={1}
                value={scrubIndex ?? history.length - 1}
                onChange={(e) => handleTimeScrub(Math.round(parseFloat(e.target.value)))}
                style={{ width: '100%', height: '6px', borderRadius: '3px', background: `linear-gradient(to right, #6366f1 ${((scrubIndex ?? history.length - 1)/Math.max(history.length - 1, 1))*100}%, #2a2a35 ${((scrubIndex ?? history.length - 1)/Math.max(history.length - 1, 1))*100}%)`, cursor: 'pointer', WebkitAppearance: 'none' }}
              />
            </div>
          )}

        {/* Visualizations with Tabs */}
        <div style={{
          background: '#111116',
          borderRadius: '12px',
          padding: '20px',
          flex: 1,
          minHeight: '400px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}>
          {/* Tab Navigation */}
          <div style={{
            display: 'flex',
            gap: '8px',
            marginBottom: '20px',
            borderBottom: '1px solid #2a2a35',
            paddingBottom: '12px',
            overflowX: 'auto',
            flexShrink: 0
          }}>
            {[
              { id: 'age-dist', label: 'Age Distribution', icon: '📊' },
              { id: 'fertility', label: 'Fertility Schedule', icon: '👶' },
              { id: 'mortality', label: 'Mortality & Survival', icon: '📉' },
              { id: 'population', label: 'Population Over Time', icon: '📈' },
              { id: 'flows', label: 'Births & Deaths', icon: '↔️' },
              { id: 'dependency', label: 'Dependency Ratio', icon: '⚖️' },
              { id: 'pyramid', label: 'Population Pyramid', icon: '🔺' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setSelectedPlot(tab.id)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: selectedPlot === tab.id ? '#6366f1' : 'transparent',
                  color: selectedPlot === tab.id ? '#fff' : '#94a3b8',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                  fontWeight: selectedPlot === tab.id ? 600 : 400,
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s'
                }}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>

          {/* Plot Container */}
          <div style={{ flex: 1, minHeight: '150px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Age Distribution */}
            {selectedPlot === 'age-dist' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <h3 style={{ color: '#f8fafc', fontSize: '1rem', marginBottom: '10px', flexShrink: 0 }}>
                  Age Distribution n(a,t) — Year {displayedHistoryEntry?.time ?? time}{isViewingHistory ? ' (history)' : ''}
                </h3>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="100%" height="100%" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid meet">
                  <rect x={35 + (15/numAges)*350} y="10" width={(35/numAges)*350} height="110" fill={`${config.color}10`} />
                  {displayedAgeDist.map((n, age) => {
                    const x = 35 + (age / numAges) * 350;
                    const height = (n / maxDist) * 100;
                    const isReproductive = age >= 15 && age < 50;
                    return (
                      <rect key={age} x={x} y={120 - height} width={3} height={height}
                        fill={isReproductive ? config.color : '#6366f1'} opacity={isReproductive ? 0.9 : 0.5} />
                    );
                  })}
                  <line x1="35" y1="120" x2="385" y2="120" stroke="#444" />
                  <line x1="35" y1="20" x2="35" y2="120" stroke="#444" />
                  {[0, 25, 50, 75, 100].map(age => (
                    <text key={age} x={35 + (age / numAges) * 350} y="132" fill="#64748b" fontSize="8" textAnchor="middle">{age}</text>
                  ))}
                  <text x="210" y="140" fill="#94a3b8" fontSize="9" textAnchor="middle">Age (years)</text>
                  <text x="32" y="23" fill="#64748b" fontSize="7" textAnchor="end">{maxDist.toFixed(0)}</text>
                  <text x="32" y="70" fill="#64748b" fontSize="7" textAnchor="end">{(maxDist/2).toFixed(0)}</text>
                  <text x="32" y="118" fill="#64748b" fontSize="7" textAnchor="end">0</text>
                  <text x="8" y="70" fill="#94a3b8" fontSize="8" textAnchor="middle" transform="rotate(-90, 8, 70)">n(a)</text>
                </svg>
                </div>
              </div>
            )}

            {/* Fertility Schedule */}
            {selectedPlot === 'fertility' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <h3 style={{ color: '#f8fafc', fontSize: '1rem', marginBottom: '10px', flexShrink: 0 }}>
                  Fertility Schedule β(a) — TFR = {totalFertility.toFixed(1)}
                </h3>
                {(() => {
                  const maxF = Math.max(...currentFertilitySchedule);
                  return (
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="100%" height="100%" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid meet">
                      <line x1="35" y1="120" x2="385" y2="120" stroke="#444" />
                      <line x1="35" y1="20" x2="35" y2="120" stroke="#444" />
                      <path
                        d={`M 35 120 ` + currentFertilitySchedule.map((f, age) => {
                          const x = 35 + (age / numAges) * 350;
                          const y = 120 - (f / maxF) * 100;
                          return `L ${x} ${Math.max(20, y)}`;
                        }).join(' ') + ` L 385 120 Z`}
                        fill={`${config.color}30`} stroke={config.color} strokeWidth="1"
                      />
                      {[15, 25, 35, 45].map(age => (
                        <text key={age} x={35 + (age / numAges) * 350} y="132" fill="#64748b" fontSize="8" textAnchor="middle">{age}</text>
                      ))}
                      <text x="210" y="140" fill="#94a3b8" fontSize="9" textAnchor="middle">Age (years)</text>
                      <text x="32" y="23" fill="#64748b" fontSize="7" textAnchor="end">{maxF.toFixed(2)}</text>
                      <text x="32" y="70" fill="#64748b" fontSize="7" textAnchor="end">{(maxF/2).toFixed(2)}</text>
                      <text x="32" y="118" fill="#64748b" fontSize="7" textAnchor="end">0</text>
                      <text x="8" y="70" fill="#94a3b8" fontSize="8" textAnchor="middle" transform="rotate(-90, 8, 70)">β(a)</text>
                      <text x={35 + (generationTime / numAges) * 350} y="12" fill={config.color} fontSize="9" textAnchor="middle">
                        T̄={generationTime.toFixed(0)}
                      </text>
                    </svg>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Mortality and Survival */}
            {selectedPlot === 'mortality' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <h3 style={{ color: '#f8fafc', fontSize: '1rem', marginBottom: '10px', flexShrink: 0 }}>
                  Mortality μ(a) & Survival l(a) — e₀ = {actualE0.toFixed(1)} years
                </h3>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="100%" height="100%" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid meet">
                  <line x1="35" y1="120" x2="385" y2="120" stroke="#444" />
                  <line x1="35" y1="20" x2="35" y2="120" stroke="#444" />
                  <path
                    d={`M 35 20 ` + survivalCurve.map((l, age) => {
                      const x = 35 + (age / numAges) * 350;
                      const y = 120 - l * 100;
                      return `L ${x} ${y}`;
                    }).join(' ')}
                    fill="none" stroke="#22c55e" strokeWidth="1"
                  />
                  <path
                    d={`M 35 120 ` + mortalityCurve.map((mu, age) => {
                      const x = 35 + (age / numAges) * 350;
                      const y = 120 - Math.min(Math.log10(mu + 0.0001) + 4, 3) * 33;
                      return `L ${x} ${Math.max(20, y)}`;
                    }).join(' ')}
                    fill="none" stroke="#ef4444" strokeWidth="1" strokeDasharray="4 2"
                  />
                  {[0, 25, 50, 75, 100].map(age => (
                    <text key={age} x={35 + (age / numAges) * 350} y="132" fill="#64748b" fontSize="8" textAnchor="middle">{age}</text>
                  ))}
                  <text x="210" y="140" fill="#94a3b8" fontSize="9" textAnchor="middle">Age (years)</text>
                  <text x="32" y="23" fill="#22c55e" fontSize="7" textAnchor="end">1.0</text>
                  <text x="32" y="70" fill="#22c55e" fontSize="7" textAnchor="end">0.5</text>
                  <text x="32" y="118" fill="#22c55e" fontSize="7" textAnchor="end">0</text>
                  <text x="8" y="70" fill="#22c55e" fontSize="8" textAnchor="middle" transform="rotate(-90, 8, 70)">l(a)</text>
                  <text x="305" y="20" fill="#22c55e" fontSize="7">── l(a)</text>
                  <text x="305" y="30" fill="#ef4444" fontSize="7">╌╌ μ(a) log</text>
                </svg>
                </div>
              </div>
            )}

            {/* Population Over Time */}
            {selectedPlot === 'population' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <h3 style={{ color: '#f8fafc', fontSize: '1rem', marginBottom: '10px', flexShrink: 0 }}>
                  Population Over Time — N = {totalPop.toLocaleString('en-US', {maximumFractionDigits: 0})}
                </h3>
                {(() => {
                  const maxPop = yAxisRanges.population.max;
                  const minPop = yAxisRanges.population.min;
                  const plotWidth = 350;
                  const tickInterval = time > 500 ? 100 : time > 200 ? 50 : time > 100 ? 25 : time > 50 ? 10 : 5;
                  const ticks = [];
                  for (let t = 0; t <= time; t += tickInterval) ticks.push(t);
                  if (time > 0 && (ticks.length === 0 || ticks[ticks.length - 1] !== time)) ticks.push(time);
                  const scrubMarkerX = isViewingHistory && scrubIndex !== null
                    ? 35 + (scrubIndex / Math.max(history.length - 1, 1)) * plotWidth 
                    : null;
                  
                  return (
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="100%" height="100%" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid meet">
                      {[0, 1, 2, 3].map(i => (
                        <line key={i} x1="35" y1={20 + i * 33} x2="385" y2={20 + i * 33} stroke="#1a1a22" />
                      ))}
                      {history.length > 1 && (
                        <path
                          d={history.map((h, i) => {
                            const x = 35 + (i / Math.max(history.length - 1, 1)) * plotWidth;
                            const range = maxPop - minPop || 1;
                            const y = 115 - ((h.population - minPop) / range) * 95;
                            return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
                          }).join(' ')}
                          fill="none" stroke="#6366f1" strokeWidth="1"
                        />
                      )}
                      {isViewingHistory && scrubMarkerX !== null && displayedHistoryEntry && (
                        <>
                          <line x1={scrubMarkerX} y1="20" x2={scrubMarkerX} y2="120" stroke="#f59e0b" strokeWidth="2" strokeDasharray="4 2" />
                          <circle cx={scrubMarkerX} cy={115 - ((displayedHistoryEntry.population - minPop) / (maxPop - minPop || 1)) * 95} r="4" fill="#f59e0b" />
                        </>
                      )}
                      <line x1="35" y1="120" x2="385" y2="120" stroke="#444" />
                      <line x1="35" y1="20" x2="35" y2="120" stroke="#444" />
                      {ticks.map((t, tickIdx) => {
                        const historyIdx = history.findIndex(h => h.time === t);
                        const xPos = historyIdx >= 0 ? 35 + (historyIdx / Math.max(history.length - 1, 1)) * plotWidth : null;
                        return xPos !== null ? <text key={t} x={xPos} y="132" fill="#64748b" fontSize="8" textAnchor="middle">{t}</text> : null;
                      })}
                      <text x="32" y="23" fill="#64748b" fontSize="7" textAnchor="end">{maxPop.toLocaleString()}</text>
                      <text x="32" y="70" fill="#64748b" fontSize="7" textAnchor="end">{((maxPop + minPop) / 2).toLocaleString()}</text>
                      <text x="32" y="118" fill="#64748b" fontSize="7" textAnchor="end">{minPop.toLocaleString()}</text>
                      <text x="8" y="70" fill="#94a3b8" fontSize="8" textAnchor="middle" transform="rotate(-90, 8, 70)">N(t)</text>
                    </svg>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Births and Deaths */}
            {selectedPlot === 'flows' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <h3 style={{ color: '#f8fafc', fontSize: '1rem', marginBottom: '10px', flexShrink: 0 }}>
                  Births & Deaths Over Time — B={(displayedHistoryEntry?.births||0).toFixed(0)} D={(displayedHistoryEntry?.deaths||0).toFixed(0)}
                </h3>
                {(() => {
                  const maxFlow = yAxisRanges.birthsDeath.max;
                  const plotWidth = 350;
                  const tickInterval = time > 500 ? 100 : time > 200 ? 50 : time > 100 ? 25 : time > 50 ? 10 : 5;
                  const ticks = [];
                  for (let t = 0; t <= time; t += tickInterval) ticks.push(t);
                  if (time > 0 && (ticks.length === 0 || ticks[ticks.length - 1] !== time)) ticks.push(time);
                  const scrubMarkerX = isViewingHistory && scrubIndex !== null
                    ? 35 + (scrubIndex / Math.max(history.length - 1, 1)) * plotWidth 
                    : null;
                  
                  return (
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="100%" height="100%" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid meet">
                      {history.length > 1 && (
                        <>
                          <path
                            d={history.map((h, i) => {
                              const x = 35 + (i / Math.max(history.length - 1, 1)) * plotWidth;
                              const y = 115 - ((h.births || 0) / maxFlow) * 95;
                              return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
                            }).join(' ')}
                            fill="none" stroke="#22c55e" strokeWidth="1"
                          />
                          <path
                            d={history.map((h, i) => {
                              const x = 35 + (i / Math.max(history.length - 1, 1)) * plotWidth;
                              const y = 115 - ((h.deaths || 0) / maxFlow) * 95;
                              return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
                            }).join(' ')}
                            fill="none" stroke="#ef4444" strokeWidth="1" strokeDasharray="4 2"
                          />
                        </>
                      )}
                      {isViewingHistory && scrubMarkerX !== null && (
                        <line x1={scrubMarkerX} y1="20" x2={scrubMarkerX} y2="120" stroke="#f59e0b" strokeWidth="2" strokeDasharray="4 2" />
                      )}
                      <line x1="35" y1="120" x2="385" y2="120" stroke="#444" />
                      <line x1="35" y1="20" x2="35" y2="120" stroke="#444" />
                      {ticks.map((t, tickIdx) => {
                        const historyIdx = history.findIndex(h => h.time === t);
                        const xPos = historyIdx >= 0 ? 35 + (historyIdx / Math.max(history.length - 1, 1)) * plotWidth : null;
                        return xPos !== null ? <text key={t} x={xPos} y="132" fill="#64748b" fontSize="8" textAnchor="middle">{t}</text> : null;
                      })}
                      <text x="32" y="23" fill="#64748b" fontSize="7" textAnchor="end">{maxFlow.toFixed(0)}</text>
                      <text x="32" y="70" fill="#64748b" fontSize="7" textAnchor="end">{(maxFlow/2).toFixed(0)}</text>
                      <text x="32" y="118" fill="#64748b" fontSize="7" textAnchor="end">0</text>
                      <text x="8" y="70" fill="#94a3b8" fontSize="8" textAnchor="middle" transform="rotate(-90, 8, 70)">Count</text>
                      <text x="320" y="20" fill="#22c55e" fontSize="7">── Births</text>
                      <text x="320" y="30" fill="#ef4444" fontSize="7">╌╌ Deaths</text>
                    </svg>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Dependency Ratio */}
            {selectedPlot === 'dependency' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <h3 style={{ color: '#f8fafc', fontSize: '1rem', marginBottom: '10px', flexShrink: 0 }}>
                  Dependency Ratio Over Time — DR = {(debugInfo.dependencyRatio || 0).toFixed(2)}
                </h3>
                {(() => {
                  const maxDep = history.length > 0 
                    ? Math.max(...history.map(h => h.dependencyRatio || 0), 0.5)
                    : 1;
                  const minDep = history.length > 0 
                    ? Math.min(...history.map(h => h.dependencyRatio || 0))
                    : 0;
                  const plotWidth = 350;
                  const tickInterval = time > 500 ? 100 : time > 200 ? 50 : time > 100 ? 25 : time > 50 ? 10 : 5;
                  const ticks = [];
                  for (let t = 0; t <= time; t += tickInterval) ticks.push(t);
                  if (time > 0 && (ticks.length === 0 || ticks[ticks.length - 1] !== time)) ticks.push(time);
                  
                  return (
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="100%" height="100%" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid meet">
                      {history.length > 1 && (
                        <path
                          d={history.map((h, i) => {
                            const x = 35 + (i / Math.max(history.length - 1, 1)) * plotWidth;
                            const range = maxDep - minDep || 1;
                            const y = 115 - ((h.dependencyRatio || 0) - minDep) / range * 95;
                            return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
                          }).join(' ')}
                          fill="none" stroke="#ec4899" strokeWidth="1"
                        />
                      )}
                      <line x1="35" y1="120" x2="385" y2="120" stroke="#444" />
                      <line x1="35" y1="20" x2="35" y2="120" stroke="#444" />
                      {ticks.map((t, tickIdx) => {
                        const historyIdx = history.findIndex(h => h.time === t);
                        const xPos = historyIdx >= 0 ? 35 + (historyIdx / Math.max(history.length - 1, 1)) * plotWidth : null;
                        return xPos !== null ? <text key={t} x={xPos} y="132" fill="#64748b" fontSize="8" textAnchor="middle">{t}</text> : null;
                      })}
                      <text x="32" y="23" fill="#64748b" fontSize="7" textAnchor="end">{maxDep.toFixed(2)}</text>
                      <text x="32" y="70" fill="#64748b" fontSize="7" textAnchor="end">{((maxDep + minDep) / 2).toFixed(2)}</text>
                      <text x="32" y="118" fill="#64748b" fontSize="7" textAnchor="end">{minDep.toFixed(2)}</text>
                      <text x="8" y="70" fill="#ec4899" fontSize="8" textAnchor="middle" transform="rotate(-90, 8, 70)">DR</text>
                    </svg>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Population Pyramid */}
            {selectedPlot === 'pyramid' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <h3 style={{ color: '#f8fafc', fontSize: '1rem', marginBottom: '10px', flexShrink: 0 }}>
                  Population Pyramid (Bigender) — Year {displayedHistoryEntry?.time ?? time}{isViewingHistory ? ' (history)' : ''}
                </h3>
                {(() => {
                  // Use actual tracked male/female populations
                  const femalePopulation = displayedFemaleDist.length > 0 ? displayedFemaleDist : displayedAgeDist.map(n => n * 0.5);
                  const malePopulation = displayedMaleDist.length > 0 ? displayedMaleDist : displayedAgeDist.map(n => n * 0.5);
                  const maxPyramid = Math.max(...femalePopulation, ...malePopulation, 100);
                  
                  return (
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="100%" height="100%" viewBox="0 0 500 280" preserveAspectRatio="xMidYMid meet">
                      {/* Center line */}
                      <line x1="250" y1="10" x2="250" y2="270" stroke="#2a2a35" strokeWidth="2" />
                      
                      {/* Age bars - continuous, one per year - inverted so age 0 is at bottom */}
                      {displayedAgeDist.map((total, age) => {
                        const female = femalePopulation[age] || 0;
                        const male = malePopulation[age] || 0;
                        
                        // Skip ages beyond 100
                        if (age >= 100) return null;
                        
                        // Position from bottom (age 0 at bottom, age 100 at top)
                        const y = 260 - (age / 100) * 250;
                        const barHeight = 2.5;
                        
                        // Scale bars
                        const femaleWidth = (female / maxPyramid) * 120;
                        const maleWidth = (male / maxPyramid) * 120;
                        
                        // Calculate balanced population (minimum of male/female at this age)
                        const balanced = Math.min(male, female);
                        const balancedMaleWidth = (balanced / maxPyramid) * 120;
                        const balancedFemaleWidth = (balanced / maxPyramid) * 120;
                        
                        // Excess is the difference
                        const excessMale = male > female;
                        const excessWidth = Math.abs(male - female) / maxPyramid * 120;
                        
                        return (
                          <g key={age}>
                            {/* Males - balanced portion (blue, lighter) */}
                            <rect 
                              x={250 - balancedMaleWidth} 
                              y={y} 
                              width={balancedMaleWidth} 
                              height={barHeight}
                              fill="#3b82f6"
                              opacity="0.7"
                            />
                            {/* Males - excess portion (dark blue) */}
                            {excessMale && excessWidth > 0 && (
                              <rect 
                                x={250 - maleWidth} 
                                y={y} 
                                width={excessWidth} 
                                height={barHeight}
                                fill="#1d4ed8"
                                opacity="1"
                              />
                            )}
                            
                            {/* Females - balanced portion (orange, lighter) */}
                            <rect 
                              x={250} 
                              y={y} 
                              width={balancedFemaleWidth} 
                              height={barHeight}
                              fill="#f97316"
                              opacity="0.7"
                            />
                            {/* Females - excess portion (dark orange) */}
                            {!excessMale && excessWidth > 0 && (
                              <rect 
                                x={250 + balancedFemaleWidth} 
                                y={y} 
                                width={excessWidth} 
                                height={barHeight}
                                fill="#c2410c"
                                opacity="1"
                              />
                            )}
                            
                            {/* Age label every 10 years */}
                            {age % 10 === 0 && (
                              <text 
                                x="250" 
                                y={y + 8} 
                                fill="#94a3b8" 
                                fontSize="10" 
                                textAnchor="middle"
                                fontWeight="500"
                              >
                                {age}
                              </text>
                            )}
                          </g>
                        );
                      })}
                      
                      {/* Legend */}
                      <g>
                        <rect x="20" y="12" width="14" height="10" fill="#3b82f6" opacity="0.7" />
                        <rect x="20" y="22" width="14" height="4" fill="#1d4ed8" opacity="1" />
                        <text x="40" y="25" fill="#94a3b8" fontSize="10">Males (dark = excess) e₀={maleE0.toFixed(1)}</text>
                        
                        <rect x="20" y="38" width="14" height="10" fill="#f97316" opacity="0.7" />
                        <rect x="20" y="48" width="14" height="4" fill="#c2410c" opacity="1" />
                        <text x="40" y="51" fill="#94a3b8" fontSize="10">Females (dark = excess) e₀={femaleE0.toFixed(1)}</text>
                        
                        <text x="20" y="72" fill="#64748b" fontSize="9">
                          Birth ratio: {(sexRatioBirth * 100).toFixed(1)}% F / {((1 - sexRatioBirth) * 100).toFixed(1)}% M
                        </text>
                        <text x="20" y="84" fill="#64748b" fontSize="9">
                          {(() => {
                            const totalF = femalePopulation.reduce((a, b) => a + b, 0);
                            const totalM = malePopulation.reduce((a, b) => a + b, 0);
                            const total = totalF + totalM;
                            if (total === 0) return 'Pop: 0% F / 0% M';
                            return `Pop: ${(totalF / total * 100).toFixed(1)}% F / ${(totalM / total * 100).toFixed(1)}% M`;
                          })()}
                        </text>
                      </g>
                      
                      {/* Y-axis label */}
                      <text x="10" y="140" fill="#94a3b8" fontSize="10" textAnchor="middle" transform="rotate(-90, 10, 140)">Age (years)</text>
                    </svg>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* Equations Reference */}
        <div style={{
          background: '#111116',
          borderRadius: '12px',
          padding: '20px',
          marginBottom: '20px'
        }}>
          <h3 style={{ color: '#f8fafc', fontSize: '1rem', marginBottom: '15px' }}>
            📐 Mathematical Model
          </h3>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '15px' }}>
            <EquationCard
              title="McKendrick-von Foerster PDE"
              equation={TEX.mckendrick}
              description="Population density n(a,t) ages at rate 1 and decreases due to mortality μ(a)"
            />
            <EquationCard
              title="Birth Boundary Condition"
              equation={TEX.birth}
              description="Newborns enter at age 0; births = integral of fertility × population"
            />
            <EquationCard
              title="Total Fertility Rate (TFR)"
              equation={TEX.tfr}
              description="Sum of age-specific fertility rates; B(a) = births to women age a, W(a) = women age a"
            />
            <EquationCard
              title="Fertility Schedule (ASFR)"
              equation={TEX.fertility}
              description="Gaussian ASFR centered at peak age μ with spread σ; Z normalizes so Σβ(a) = TFR"
            />
            <EquationCard
              title="Siler Mortality Model"
              equation={TEX.siler}
              description="Infant mortality (α₁e^(-β₁a), declining) + background (α₂, constant) + senescent (α₃e^(β₃a), Gompertz aging). Parameters scale with e₀."
            />
            <EquationCard
              title="Survival Function"
              equation={TEX.survival}
              description="Probability of surviving from birth to age a"
            />
            <EquationCard
              title="Life Expectancy at Birth"
              equation={TEX.lifeExp}
              description="Expected years of life at birth = area under survival curve"
            />
            <EquationCard
              title="Net Reproduction Rate"
              equation={TEX.R0}
              description="Expected daughters per woman (fₘ ≈ 0.488 = female sex ratio at birth); R₀ > 1 → growth"
            />
            <EquationCard
              title="Mean Generation Time"
              equation={TEX.genTime}
              description="Mean age of mothers at childbirth; determines population momentum timescale"
            />
            <EquationCard
              title="Intrinsic Growth Rate (Lotka's r)"
              equation={TEX.intrinsic}
              description="Long-term exponential growth rate; positive means growth, negative means decline"
            />
            <EquationCard
              title="Dependency Ratio"
              equation={TEX.dependency}
              description="Non-working age population divided by working age population"
            />
          </div>
        </div>

        {/* Debug Panel */}
        <div style={{
          background: '#1a0a0a',
          borderRadius: '12px',
          padding: '15px',
          border: '1px solid #3a2020'
        }}>
          <h4 style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '10px' }}>
            🔧 Debug Values (per time step)
          </h4>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', 
            gap: '10px',
            fontSize: '0.75rem',
            color: '#94a3b8'
          }}>
            <DebugItem label="Births/yr" value={(debugInfo.births || 0).toFixed(2)} color="#22c55e" />
            <DebugItem label="Deaths/yr" value={(debugInfo.deaths || 0).toFixed(2)} color="#ef4444" />
            <DebugItem label="B/D Ratio" value={(debugInfo.birthDeathRatio || 0).toFixed(4)} 
              color={debugInfo.birthDeathRatio >= 1 ? '#22c55e' : '#ef4444'} />
            <DebugItem label="Σβ(a) = TFR" value={(debugInfo.fertilitySum || 0).toFixed(3)} color="#f59e0b" />
            <DebugItem label="Max ASFR" value={(debugInfo.maxASFR || 0).toFixed(4)} color="#8b5cf6" />
            <DebugItem label="Peak β age" value={debugInfo.peakAge || '-'} color="#8b5cf6" />
            <DebugItem label="Women 15-49" value={(debugInfo.fertileWomen || 0).toFixed(0)} color="#06b6d4" />
            <DebugItem label="R₀" value={netReproductionRate.toFixed(4)} 
              color={netReproductionRate >= 1 ? '#22c55e' : '#ef4444'} />
          </div>
        </div>
      </div>
    </div>
    </div>
  );
};

// === HELPER COMPONENTS ===

const MetricBox = ({ label, value, color }) => (
  <div style={{ textAlign: 'center' }}>
    <div style={{ color: '#64748b', fontSize: '0.7rem', marginBottom: '2px' }}>{label}</div>
    <div style={{ color, fontSize: '1.1rem', fontWeight: 600 }}>{value}</div>
  </div>
);

const SliderControl = ({ label, value, onChange, min, max, step, equation, description, color, marks }) => {
  const [inputValue, setInputValue] = React.useState(String(value));
  const [isEditing, setIsEditing] = React.useState(false);
  
  React.useEffect(() => {
    if (!isEditing) {
      setInputValue(String(value));
    }
  }, [value, isEditing]);
  
  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };
  
  const handleInputBlur = () => {
    setIsEditing(false);
    const num = parseFloat(inputValue);
    if (!isNaN(num)) {
      const clamped = Math.max(min, Math.min(max, num));
      onChange(clamped);
      setInputValue(String(clamped));
    } else {
      setInputValue(String(value));
    }
  };
  
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.target.blur();
    }
  };
  
  const formatDisplay = (val) => {
    if (val >= 1000000000) return `${(val / 1000000000).toLocaleString()}B`;
    if (val >= 1000000) return `${(val / 1000000).toLocaleString()}M`;
    if (val >= 1000) return val.toLocaleString();
    return val;
  };
  
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '5px' }}>
        <label style={{ color: '#94a3b8', fontSize: '0.85rem' }}>{label}</label>
        <input
          type="text"
          value={isEditing ? inputValue : formatDisplay(value)}
          onChange={handleInputChange}
          onFocus={() => { setIsEditing(true); setInputValue(String(value)); }}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          style={{
            color,
            fontSize: '1.1rem',
            fontWeight: 600,
            background: isEditing ? '#1a1a2e' : 'transparent',
            border: isEditing ? `1px solid ${color}` : '1px solid transparent',
            borderRadius: '4px',
            padding: '2px 6px',
            textAlign: 'right',
            width: '120px',
            outline: 'none'
          }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: color }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#475569', marginTop: '2px' }}>
        {marks?.map((m, i) => <span key={i}>{m.label}</span>)}
      </div>
      <div style={{ marginTop: '5px', padding: '6px 8px', background: '#0a0a0e', borderRadius: '4px' }}>
        <code style={{ color, fontSize: '0.75rem' }}>{equation}</code>
        <div style={{ color: '#64748b', fontSize: '0.7rem', marginTop: '2px' }}>{description}</div>
      </div>
    </div>
  );
};

const PlotPanel = ({ title, subtitle, children }) => (
  <div style={{ background: '#111116', borderRadius: '12px', padding: '15px' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
      <h4 style={{ color: '#94a3b8', fontSize: '0.85rem', margin: 0 }}>{title}</h4>
      <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{subtitle}</span>
    </div>
    <div style={{ height: '140px', background: '#0a0a0e', borderRadius: '8px' }}>
      {children}
    </div>
  </div>
);

const EquationCard = ({ title, equation, description }) => {
  const renderedHtml = React.useMemo(() => {
    try {
      return katex.renderToString(equation, {
        throwOnError: false,
        displayMode: true,
        strict: false
      });
    } catch (e) {
      console.error('KaTeX error:', e);
      return `<span style="color:red">${equation}</span>`;
    }
  }, [equation]);
  
  return (
    <div style={{ background: '#0a0a0e', borderRadius: '8px', padding: '12px' }}>
      <h5 style={{ color: '#f8fafc', fontSize: '0.85rem', marginBottom: '6px' }}>{title}</h5>
      <div 
        style={{ 
          display: 'block', 
          color: '#8b5cf6', 
          fontSize: '1rem', 
          marginBottom: '6px',
          padding: '8px 10px',
          background: '#111116',
          borderRadius: '4px',
          overflowX: 'auto'
        }}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
      <p style={{ color: '#64748b', fontSize: '0.75rem', margin: 0, lineHeight: 1.4 }}>{description}</p>
    </div>
  );
};

const DebugItem = ({ label, value, color }) => (
  <div>
    <span style={{ color: '#64748b' }}>{label}: </span>
    <span style={{ color }}>{value}</span>
  </div>
);

export default ReproductiveAgeExplorer;
