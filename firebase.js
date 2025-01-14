// Import the functions you need from the SDKs



import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD-x7xKwvWaxALs8uDjKPx_N0uMELsn5b8",
  authDomain: "website-orders-5a881.firebaseapp.com",
  projectId: "website-orders-5a881",
  storageBucket: "website-orders-5a881.firebasestorage.app",
  messagingSenderId: "8464783361",
  appId: "1:8464783361:web:917c7cf38b67e0867f4800",
  measurementId: "G-REB6E9EC8E"
  // apiKey: "AIzaSyDHa8FhlLfQ7FNByCVzKbSVBUDDQ4I_oWs",
  // authDomain: "fir-github-pages.firebaseapp.com",
  // projectId: "fir-github-pages",
  // storageBucket: "fir-github-pages.firebasestorage.app",
  // messagingSenderId: "351695761896",
  // appId: "1:351695761896:web:c4238d06976f90cdbeb45d",
  // databaseURL: "https://fir-github-pages-default-rtdb.firebaseio.com/",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firestore
const db = getFirestore(app);

document.addEventListener("DOMContentLoaded", () => {
  // Function to extract name and cost
  const extractNameAndCost = () => {
    const getItemsData = (selector, nameSelector, costSelector) => {
        const elements = document.querySelectorAll(selector); // Select all matching elements
        const data = [];
        elements.forEach((element) => {
            const nameElement = element.querySelector(nameSelector);
            const costElement = element.querySelector(costSelector);
            const cost = costElement ? parseFloat(costElement.textContent.trim().replace(/[^\d.-]/g, "")) : 0; // Extract numeric cost
            data.push({
                name: nameElement ? nameElement.textContent.trim() : "N/A",
                cost: cost,
            });
        });
        return data;
    };

    // Collect data for all necessary items
    const necessaryData = getItemsData(".necessary", "h2", ".cost");

    // Collect data for selected charger
    const chargerSelectedData = getItemsData(".charger.selected", "h3", ".cost");

    // Collect data for additional accessories only if `border-text-container additional` has `selected` class
    const additionalElements = document.querySelectorAll(".additional-accessories");
    const additionalData = [];
    additionalElements.forEach((element) => {
        const additionalContainer = element.querySelector(".border-text-container.additional.selected");
        if (additionalContainer) {
            const nameElement = additionalContainer.querySelector("h3");
            const costElement = element.querySelector(".cost");
            const name = nameElement ? nameElement.textContent.trim() : "N/A";
            const cost = costElement ? parseFloat(costElement.textContent.trim().replace(/[^\d.-]/g, "")) : 0;
            additionalData.push({ name, cost });
        }
    });

    // Calculate total cost
    const totalCost = [...necessaryData, ...chargerSelectedData, ...additionalData].reduce(
        (sum, item) => sum + item.cost,
        0
    );

    // Prepare data to save to Firebase
    const data = {
        timestamp: new Date().toLocaleString(), // Add timestamp in ISO format
        totalCost: totalCost,
        items: {
            necessary: necessaryData,
            chargerSelected: chargerSelectedData,
            additional: additionalData,
        },
    };

    console.log("Data to save:", data);

    // Save data to Firebase Firestore
    saveToFirebase(data);
};


const saveToFirebase = async (data) => {
  try {
    console.log("Saving to Firebase:", data);
    // Add data to the "orders" collection with an auto-generated ID
    const docRef = await addDoc(collection(db, "orders"), data);

    
    
    // Log the document ID
    console.log("Document saved with ID:", docRef.id);
  } catch (error) {
    console.error("Error saving data to Firestore:", error);
  }};


  // Add click event listener to "Save to Firebase" button
  const saveButton = document.querySelector("#save-firebase");
  if (saveButton) {
      saveButton.addEventListener("click", (e) => {
          e.preventDefault(); // Prevent default link behavior
          extractNameAndCost(); // Extract data and save to Firebase
      });
  }
});

