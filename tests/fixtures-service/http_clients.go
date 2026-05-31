package svc

import "net/http"

// http.Get — should record GET /api/users via framework=http.
func ListUsers() (*http.Response, error) {
	return http.Get("/api/users")
}

// http.Post — POST /api/users via framework=http.
func CreateUser(body interface{}) (*http.Response, error) {
	return http.Post("/api/users", "application/json", nil)
}

// client.Get — generic http-client framework.
func FetchOrders(client *http.Client) (*http.Response, error) {
	return client.Get("/api/orders")
}

// http.NewRequest("POST", ...) — method derived from first string arg.
func MakeRequest() (*http.Request, error) {
	return http.NewRequest("POST", "/api/items", nil)
}
