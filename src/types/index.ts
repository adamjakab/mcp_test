export interface OAuthToken {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: string;
}

export interface User {
    id: string;
    name: string;
    email: string;
}

export interface MCPRequest {
    user: User;
    body: any;
    params: Record<string, any>;
    query: Record<string, any>;
}

export interface MCPResponse {
    status: (code: number) => MCPResponse;
    json: (data: any) => void;
    send: (data: any) => void;
}

export interface Middleware {
    (req: MCPRequest, res: MCPResponse, next: () => void): void;
}

export type Token = OAuthToken;