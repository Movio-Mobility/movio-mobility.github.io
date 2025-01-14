document.addEventListener("DOMContentLoaded", () => {
    const costElements = document.querySelectorAll(".cost"); // Get all elements with the class "cost"
    const totalElement = document.getElementById("cost"); // Get the total cost element
    const chargers = document.querySelectorAll(".charger"); // Get charger options
    const additionalContainer = document.querySelector(".additional"); // Optional container

    const calculateTotal = () => {
        let total = 0;

        // console.log("Calculating total cost:");

        // Add the cost of necessary elements
        costElements.forEach((costElement) => {
            const parent = costElement.closest(".charger, .text-container");
            if (!parent || parent.classList.contains("necessary")) {
                const cost = parseInt(costElement.textContent.replace("₹", ""), 10);
                console.log(`Added necessary cost: ₹${cost}`);
                total += cost;
            }
        });

        // Add the selected charger cost
        chargers.forEach((charger) => {
            const isSelected = charger.classList.contains("selected");
            if (isSelected) {
                const cost = charger.querySelector(".cost");
                const costValue = parseInt(cost.textContent.replace("₹", ""), 10);
                console.log(`Added selected charger cost: ₹${costValue}`);
                total += costValue;
            }
        });

        // Add the optional container cost if it exists and is selected
        if (additionalContainer && additionalContainer.classList.contains("selected")) {
            const cost = additionalContainer.querySelector(".cost");
            const costValue = parseInt(cost.textContent.replace("₹", ""), 10);
            console.log(`Added optional container cost: ₹${costValue}`);
            total += costValue;
        }

        console.log(`Total cost calculated: ₹${total}`);
        totalElement.textContent = `₹${total}`;
    };

    // Event listeners for charger selection
    chargers.forEach((charger) => {
        charger.addEventListener("click", () => {
            // console.log("Charger clicked");
            // Unselect other chargers
            chargers.forEach((c) => c.classList.remove("selected"));
            charger.classList.add("selected");
            calculateTotal();
        });
    });

    // Event listener for optional container selection (if applicable)
    if (additionalContainer) {
        additionalContainer.addEventListener("click", () => {
            // console.log("Optional container clicked");
            additionalContainer.classList.toggle("selected");
            calculateTotal();
        });
    }

    // Initial calculation
    calculateTotal();
});
