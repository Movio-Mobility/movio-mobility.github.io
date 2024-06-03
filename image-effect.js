function initializeGallery(galleryId) {
  const gallery = document.getElementById(galleryId);
  const largeBoxImage = gallery.querySelector(".large-box-image");
  const smallBoxesContainer = gallery.querySelector(".small-boxes-container");
  const smallBoxes = smallBoxesContainer.children;
  let currentIndex = 0;

  function showImage(src, element) {
    // Set the large image source to the clicked small image
    largeBoxImage.src = src;

    // Remove the active class from all small boxes
    for (let box of smallBoxes) {
      box.classList.remove("active-box");
    }

    // Add the active class to the clicked box
    element.classList.add("active-box");
  }

  // Add click event listeners to small boxes
  for (let box of smallBoxes) {
    box.addEventListener("click", function () {
      const img = this.querySelector("img");
      showImage(img.src, this);
      currentIndex = Array.from(smallBoxes).indexOf(this); // Update the current index to the clicked image
    });
  }

  // Set the first image as the default large image on load
  if (smallBoxes.length > 0) {
    const firstImage = smallBoxes[0].querySelector("img").src;
    largeBoxImage.src = firstImage;
    smallBoxes[0].classList.add("active-box");
  }

  // Automatically change the image every 5 seconds
  setInterval(() => {
    currentIndex = (currentIndex + 1) % smallBoxes.length;
    const nextImage = smallBoxes[currentIndex].querySelector("img").src;
    showImage(nextImage, smallBoxes[currentIndex]);
  }, 5000); // Change image every 5 seconds
}

// Initialize all galleries
document.addEventListener("DOMContentLoaded", () => {
  for (let i = 1; i <= 14; i++) {
    initializeGallery(`gallery${i}`);
  }
});
