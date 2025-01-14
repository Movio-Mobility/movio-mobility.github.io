// Get today's date
const today = new Date();

// Calculate 4 days from today
const startDate = new Date();
startDate.setDate(today.getDate() + 4);

// Calculate 6 days from today
const endDate = new Date();
endDate.setDate(today.getDate() + 6);

// Format dates as "DDth Mon" (e.g., "26th Nov")
const formatDate = (date) => {
  const day = date.getDate();
  const month = date.toLocaleString('default', { month: 'short' });
  const suffix = (day % 10 === 1 && day !== 11) ? 'st' :
                 (day % 10 === 2 && day !== 12) ? 'nd' :
                 (day % 10 === 3 && day !== 13) ? 'rd' : 'th';
  return `${day}${suffix} ${month}`;
};

// Update the HTML content
const deliveryDateElement = document.getElementById('delivery-date');
deliveryDateElement.textContent = `Free Delivery by ${formatDate(startDate)} - ${formatDate(endDate)}`;
