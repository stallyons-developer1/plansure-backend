const fieldError = (field, message) => ({
  field,
  message,
});

const sendValidationError = (res, errors, statusCode = 400) => {
  return res.status(statusCode).json({
    success: false,
    errors: Array.isArray(errors) ? errors : [errors],
  });
};

const sendError = (res, message, statusCode = 500) => {
  return res.status(statusCode).json({
    success: false,
    message,
  });
};

const sendSuccess = (res, data, message = "Success", statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    ...data,
  });
};

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

const formatFieldName = (field) => {
  return field
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
};

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { field: "email", message: "Please enter a valid email address" };
  }
  return null;
};

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
