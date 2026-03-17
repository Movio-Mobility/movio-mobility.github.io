/**
 * Firebase configuration (obfuscated). Decodes at runtime.
 * Real security: restrict API key in Google Cloud Console (HTTP referrer).
 */
const _ = 'eyJhcGlLZXkiOiJBSXphU3lBVXgtSDlCSy1XSjZNWW5JOE1LVkhJLVFVcnhxdUZqaWsiLCJhdXRoRG9tYWluIjoid2Vic2l0ZWdyaWR4LmZpcmViYXNlYXBwLmNvbSIsInByb2plY3RJZCI6IndlYnNpdGVncmlkeCIsInN0b3JhZ2VCdWNrZXQiOiJ3ZWJzaXRlZ3JpZHguZmlyZWJhc2VzdG9yYWdlLmFwcCIsIm1lc3NhZ2luZ1NlbmRlcklkIjoiMzA5ODAyOTMwOTIxIiwiYXBwSWQiOiIxOjMwOTgwMjkzMDkyMTp3ZWI6ODM5YmEyNDdiYzk2OGMyNDZmZDY3OCIsIm1lYXN1cmVtZW50SWQiOiJHLU5QQkJZVkNGNFIifQ==';
export const firebaseConfig = JSON.parse(atob(_));
