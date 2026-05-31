// Fixture: Go gRPC client stub calls.
package fixtures

import (
	"context"
	pb "example.com/proto"
)

// GetUserViaGrpc creates a UserServiceClient and calls GetUser.
// Operation = "UserService/GetUser".
func GetUserViaGrpc(ctx context.Context, conn pb.Conn, id string) (*pb.GetUserResponse, error) {
	return pb.NewUserServiceClient(conn).GetUser(ctx, &pb.GetUserRequest{Id: id})
}

// CreateUserViaGrpc — Operation = "UserService/CreateUser".
func CreateUserViaGrpc(ctx context.Context, conn pb.Conn, name string) (*pb.CreateUserResponse, error) {
	return pb.NewUserServiceClient(conn).CreateUser(ctx, &pb.CreateUserRequest{Name: name})
}

// LoginViaGrpc — operation = "AuthService/Login".
func LoginViaGrpc(ctx context.Context, conn pb.Conn, u, p string) (*pb.LoginResponse, error) {
	return pb.NewAuthServiceClient(conn).Login(ctx, &pb.LoginRequest{Username: u, Password: p})
}

// CallUnknown — an unresolved gRPC method (NoSuchMethod doesn't exist in our
// .proto). The call should be recorded as a service_call but NOT produce a
// service_link.
func CallUnknown(ctx context.Context, conn pb.Conn) (interface{}, error) {
	return pb.NewUserServiceClient(conn).NoSuchMethod(ctx, &pb.GetUserRequest{})
}
