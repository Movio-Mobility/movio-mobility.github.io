
document.addEventListener("DOMContentLoaded", () => {
    const chargers = document.querySelectorAll(".charger"); // Charger options
    const sliderImages = document.querySelectorAll(".charger-image img"); // Slider images
    const chargerImageSets = {
      
        "Charger": [
            "./assets/normal_charger.jpg",
            "./assets/normal_charger.jpg",
            "./assets/normal_charger.jpg",
            "./assets/normal_charger.jpg"
        ],
        "Fast Charger": [
            "./assets/ev_dock.jpg",
            "./assets/ev_dock.jpg",
            "./assets/ev_dock.jpg",
            "./assets/ev_dock.jpg"
        ]
    };

    const updateSliderImages = (chargerName) => {
        const images = chargerImageSets[chargerName]; // this is printing emply list
        if (images) {
          

          
            sliderImages.forEach((img, index) => {
              // console.log(`${images[index]}`);              
                img.src = images[index] || ""; 
                img.alt = `${chargerName} Image ${index + 1}`;
            });
        }
    };

    // Event listeners for charger selection
    chargers.forEach((charger) => {
        charger.addEventListener("click", () => {
            chargers.forEach((c) => c.classList.remove("selected")); // Unselect all chargers
            charger.classList.add("selected"); // Mark the clicked charger as selected

            const chargerName = charger.querySelector("h3").textContent.trim();
            // console.log(`Selected charger: ${chargerName}`);
            updateSliderImages(chargerName); // Update the slider images
        });
    });

    // Initialize with the selected charger
    const initialSelectedCharger = document.querySelector(".charger.selected h3").textContent.trim();
    updateSliderImages(initialSelectedCharger);
});