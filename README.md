# Reproductive Age & Demographic Inertia Explorer

An interactive visualization of the McKendrick-von Foerster equation showing how reproductive timing affects population dynamics.

## Key Fix from Original

The original code had a bug where births were scaled by an arbitrary `0.5` factor, causing population decline even at replacement fertility (TFR = 2.1). This has been fixed with a properly calibrated scaling factor.

## The Math

The simulation implements the **McKendrick-von Foerster PDE**:

```
∂n/∂t + ∂n/∂a = -μ(a)·n
```

With the **renewal equation** (boundary condition):

```
n(0,t) = ∫₁₅⁴⁹ β(a)·n(a,t) da
```

Where:
- `n(a,t)` = population density at age `a` and time `t`
- `μ(a)` = age-specific mortality (Gompertz curve)
- `β(a)` = age-specific fertility (Gaussian distribution)

## Running Locally

### Prerequisites
- Node.js 18+ installed
- npm or yarn

### Setup

```bash
# Navigate to project directory
cd reproductive-age-explorer

# Install dependencies
npm install

# Start development server
npm run dev
```

Then open http://localhost:5173 in your browser.

### Building for Production

```bash
npm run build
npm run preview
```

## What to Explore

1. **Baseline vs Early vs Late reproduction**: See how peak fertility age affects generation time and momentum duration

2. **TFR slider**: 
   - Below 2.1 → gradual decline
   - At 2.1 → approximately stable (may have slight drift due to discretization)
   - Above 2.1 → growth

3. **Bimodal scenario**: Two reproductive peaks create interference patterns

4. **Shifting scenario**: Watch how modernization (delayed childbearing over time) compounds demographic inertia

## Key Insight

The same Total Fertility Rate with different *timing* produces different population dynamics. Early reproduction = faster turnover = quicker response to policy changes. Late reproduction = slower turnover = longer-lasting momentum.
