// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAGvHKgiOd6PLxrahi9sIYZ4HpCgS6GMNs",
  authDomain: "gltrades-6b72a.firebaseapp.com",
  projectId: "gltrades-6b72a",
  storageBucket: "gltrades-6b72a.firebasestorage.app",
  messagingSenderId: "91713267759",
  appId: "1:91713267759:web:bfb96a72845a71667bfeda"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize services
const auth = firebase.auth();
const db = firebase.firestore();

// Admin email constant
const ADMIN_EMAIL = "torrancegreen22@yahoo.com";
