// Authentication Manager class
class AuthManager {
  constructor() {
    this.currentUser = null;
    this.userRole = null;
    this.initializeAuthListener();
  }

  // Initialize authentication state listener
  initializeAuthListener() {
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        this.currentUser = user;
        await this.loadUserRole();

        // If on auth page, redirect to main app
        if (window.location.pathname.includes('auth.html')) {
          window.location.href = 'index.html';
        } else {
          // Initialize main app if on index page
          if (typeof window.initializeApp === 'function') {
            window.initializeApp();
          }
          document.body.style.opacity = '1';
        }
      } else {
        this.currentUser = null;
        this.userRole = null;

        // If not on auth page, redirect to login
        if (!window.location.pathname.includes('auth.html')) {
          window.location.href = 'auth.html';
        }
      }
    });
  }

  // Load user role from Firestore
  async loadUserRole() {
    try {
      const userDoc = await db.collection('users').doc(this.currentUser.uid).get();
      if (userDoc.exists) {
        this.userRole = userDoc.data().role;
      }
    } catch (error) {
      console.error('Error loading user role:', error);
    }
  }

  // Login with email and password
  async login(email, password) {
    try {
      const userCredential = await auth.signInWithEmailAndPassword(email, password);
      return { success: true, user: userCredential.user };
    } catch (error) {
      return { success: false, error: this.getErrorMessage(error.code) };
    }
  }

  // Sign up with email and password
  async signup(email, password) {
    try {
      const userCredential = await auth.createUserWithEmailAndPassword(email, password);
      const user = userCredential.user;

      const role =
        email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'user';

      await db.collection('users').doc(user.uid).set({
        email: email,
        role: role,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      return { success: true, user };
    } catch (error) {
      return { success: false, error: this.getErrorMessage(error.code) };
    }
  }

  // Logout
  async logout() {
    try {
      await auth.signOut();
      window.location.href = 'auth.html';
      return { success: true };
    } catch (error) {
      return { success: false, error: this.getErrorMessage(error.code) };
    }
  }

  // User-friendly error messages
  getErrorMessage(errorCode) {
    const errorMessages = {
      'auth/email-already-in-use': 'This email is already registered.',
      'auth/invalid-email': 'Invalid email address.',
      'auth/operation-not-allowed': 'Email/password auth not enabled.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/user-disabled': 'This account has been disabled.',
      'auth/user-not-found': 'No account found with this email.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Invalid email or password.',
      'auth/too-many-requests': 'Too many attempts. Try again later.'
    };
    return errorMessages[errorCode] || 'An error occurred.';
  }

  isAdmin() {
    return this.userRole === 'admin';
  }

  getUserId() {
    return this.currentUser ? this.currentUser.uid : null;
  }

  getUserEmail() {
    return this.currentUser ? this.currentUser.email : null;
  }
}

// Initialize auth manager
const authManager = new AuthManager();

// Auth page logic (auth.html only)
if (window.location.pathname.includes('auth.html')) {
  document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelectorAll('.auth-tab');
    const forms = document.querySelectorAll('.auth-form');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;

        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        forms.forEach(f => f.classList.remove('active'));
        document.getElementById(`${tabName}-form`).classList.add('active');

        hideMessages();
      });
    });

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;

      hideMessages();
      const result = await authManager.login(email, password);
      if (!result.success) showError(result.error);
    });

    document.getElementById('signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('signup-email').value;
      const password = document.getElementById('signup-password').value;
      const confirm = document.getElementById('signup-password-confirm').value;

      if (password !== confirm) {
        showError('Passwords do not match.');
        return;
      }

      hideMessages();
      const result = await authManager.signup(email, password);
      if (!result.success) showError(result.error);
    });

    function showError(msg) {
      const el = document.getElementById('error-message');
      el.textContent = msg;
      el.classList.add('show');
    }

    function hideMessages() {
      document.getElementById('error-message').classList.remove('show');
    }
  });
}

// Logout button (index.html)
if (!window.location.pathname.includes('auth.html')) {
  document.addEventListener('DOMContentLoaded', () => {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await authManager.logout();
      });
    }
  });
}
