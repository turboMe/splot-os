---
name: menu-engineering-cogs-matrix
description: "Use for gastro & HoReCa menu engineering matrix: classifying dishes into Stars, Plowhorses, Puzzles, Dogs based on margin and sales volume, optimizing Food Cost / CoGS."
category: consulting
keywords:
  - gastro
  - menu-engineering
  - food-cost
  - cogs
  - restaurant
  - consulting
minComplexity: medium
recommendedTier: balanced
preferLocal: false
estimatedTokens: 403
outputFormat: markdown
tags:
  - consulting
  - horeca
  - reasoning-tier
version: 1
---

# Procedure: Menu Engineering Matrix & Food Cost (CoGS) Optimizer

Use this procedure (for GastroBridge and restaurant consulting audits) to analyze menu sales data, dish gross margins, and portion food costs.

---

## 1. The BCG / Kasavana-Smith Menu Matrix

Classify each dish into one of 4 quadrants based on **Gross Margin (Profitability)** and **Sales Volume (Popularity)**:

1. ⭐ **Stars (High Profit, High Volume):**
   - Keep recipes consistent; do not alter quality.
   - Maintain prime menu placement (Golden Triangle).

2. 🐎 **Plowhorses (Low Profit, High Volume):**
   - High popularity but thin margin.
   - Action: Slightly increase price, re-engineer portion sizing, or negotiate lower supplier ingredient costs.

3. 🧩 **Puzzles (High Profit, Low Volume):**
   - High margin but low sales.
   - Action: Rename dish, improve menu description, reposition visually, or train service staff to up-sell.

4. 🐕 **Dogs (Low Profit, Low Volume):**
   - Low margin, low sales, high prep waste.
   - Action: Eliminate from menu or replace with high-margin alternative.

---

## 2. Output Contract

```markdown
### 🍽️ Menu Engineering Audit

| Item Name | Cost / Portion | Selling Price | Food Cost % | Margin | Volume | Classification | Action Strategy |
|---|---|---|---|---|---|---|---|
| Truffle Pasta | 14.50 zł | 58.00 zł | 25% | 43.50 zł | High | ⭐ Star | Protect quality, highlight |
| Classic Burger | 18.00 zł | 36.00 zł | 50% | 18.00 zł | High | 🐎 Plowhorse | Price bump to 39 zł (+8% margin) |

#### Profit Improvement Potential:
- **Estimated Monthly Gross Margin Lift:** +X,XXX zł
```
