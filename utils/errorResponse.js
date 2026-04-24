// Standardized error response format

// Single field error
const fieldError = (field, message) => ({
  field,
  message,
});

// Send validation errors response
const sendValidationError = (res, errors, statusCode = 400) => {
  return res.status(statusCode).json({
    success: false,
    errors: Array.isArray(errors) ? errors : [errors],
  });
};

// Send general error response
const sendError = (res, message, statusCode = 500) => {
  return res.status(statusCode).json({
    success: false,
    message,
  });
};

// Send success response
const sendSuccess = (res, data, message = "Success", statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    ...data,
  });
};

// Validate required fields and return errors array
const validateRequired = (fields) => {
  const errors = [];

  Object.entries(fields).forEach(([field, value]) => {
    if (!value || (typeof value === "string" && !value.trim())) {
      errors.push({
        field,
        message: `${formatFieldName(field)} is required`,
      });
    }
  });

  return errors;
};

// Format field name for display (camelCase to Title Case)
const formatFieldName = (field) => {
  return field
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
};

// Email validation
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { field: "email", message: "Please enter a valid email address" };
  }
  return null;
};

// Password validation
const validatePassword = (password, minLength = 6) => {
  if (password && password.length < minLength) {
    return {
      field: "password",
      message: `Password must be at least ${minLength} characters`,
    };
  }
  return null;
};

module.exports = {
  fieldError,
  sendValidationError,
  sendError,
  sendSuccess,
  validateRequired,
  validateEmail,
  validatePassword,
};
