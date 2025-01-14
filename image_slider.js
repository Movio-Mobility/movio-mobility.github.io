document.querySelectorAll('.slider').forEach((slider) => {
    const imageContainer = slider.querySelector('.image-container');
    const images = imageContainer.querySelectorAll('img');
    const leftArrow = slider.querySelector('.left-arrow');
    const rightArrow = slider.querySelector('.right-arrow');
  
    let currentIndex = 0;
  
    const updateSlider = () => {
        // console.log("update slider called");
        
      const offset = -currentIndex * 100; // Each image takes up 100% width
      imageContainer.style.transform = `translateX(${offset}%)`;
    };
  
    // Left arrow click
    leftArrow.addEventListener('click', () => {
        // console.log( "LEFT slider called");
      if (currentIndex > 0) {
        currentIndex--;
        updateSlider();
      }
    });
  
    // Right arrow click
    rightArrow.addEventListener('click', () => {
        // console.log("Right slider called");
      if (currentIndex < images.length - 1) {
        currentIndex++;
        updateSlider();
      }
    });
  });
  