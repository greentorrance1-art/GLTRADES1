# GLTRADES — Trading Journal Web App (Auth + RBAC)

**GLTRADES** is a workflow-first trading journal web application I designed and built to help traders record trades quickly, review performance clearly, and improve decision-making over time.

Most journals turn into “more stats.” This one is built around the real loop:

**Trade → Record → Review → Adjust**

**Live Demo:** https://greentorrance1-art.github.io/GLTRADES1/

---

## What this is (in plain English)

GLTRADES is a secure web-based trading journal where users can log trades behind a login, store their data privately, and review patterns without getting overwhelmed by noise.

It’s built to reduce **post-trade cognitive load** and make performance review feel like a clear workflow instead of a spreadsheet.

---

## Core features

### ✅ Authentication (Trust & Privacy)
- Secure login with **Firebase Authentication**
- Users log trades behind an account (protects personal financial behavior)

### ✅ Authorization (RBAC) + Data Isolation
- **Role-Based Access Control (RBAC)** + **Firestore security rules**
- Prevents cross-user access (each user can only read/write their own data)
- Supports admin vs. user permission logic (where applicable)

### ✅ Workflow-First Trade Capture
- Trade entry structured to capture what actually drives outcomes
- Designed to prioritize **pattern recognition** over raw data overload

### ✅ Review & Pattern Recognition
- Review flow built to help users spot repeated behaviors (not just numbers)
- Cleaner dashboard emphasis: insight > clutter

---

## Key iterations (real build decisions)

This project evolved through practical iteration—changes were made when the system needed more trust, clarity, and structure:

1) **Trust & privacy iteration**
- Added Firebase Authentication after recognizing users need trust to log financial behavior.

2) **Authorization iteration**
- Implemented RBAC + Firestore rules to enforce secure user data isolation and prevent cross-user access.

3) **Decision-quality iteration**
- Rebuilt trade entry into a more structured format to capture decision drivers (setup, reason, risk, execution, emotions).

4) **Review iteration**
- Shifted emphasis from “more stats” to pattern recognition to reduce distraction and improve clarity.

---

## Tech stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend (Serverless):** Firebase (Authentication + Firestore)
- **Deployment:** GitHub Pages

---

## Project structure

- `/css` — styling
- `/js` — application logic
- `index.html` — main UI
- `auth.html` — authentication UI/flow
- `firebase-config.js` — Firebase configuration (public client config)

---

